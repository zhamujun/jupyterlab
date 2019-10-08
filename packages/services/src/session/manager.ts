// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Poll } from '@jupyterlab/coreutils';

import { IIterator, iter, every } from '@phosphor/algorithm';

import { JSONExt, JSONObject } from '@phosphor/coreutils';

import { ISignal, Signal } from '@phosphor/signaling';

import { ServerConnection } from '../serverconnection';

import { Session } from './session';
import { BaseManager } from '../basemanager';
import { SessionConnection } from './default';
import { startSession, shutdownSession, listRunning } from './restapi';
import { Kernel } from '../kernel';

/**
 * We have a session manager that maintains a list of models from the server.
 * Separately, we have a list of running sessions maintained by the
 * DefaultSessions
 *
 * Perhaps we have *one* list of models, with a separate possible session
 * connection for each model.
 *
 * Also, we should be able to modify the session information without a session
 * connection - that's just a server request, and doesn't require a kernel
 * connection.
 *
 * So how about this:
 *
 * - every session model has an associated ISession instance. Since we don't
 *   want to open up websockets for *every* session, an ISession instance may
 *   not have a kernel connection.
 * -
 */

/**
 * An implementation of a session manager.
 */
export class SessionManager extends BaseManager implements Session.IManager {
  /**
   * Construct a new session manager.
   *
   * @param options - The default options for each session.
   */
  constructor(options: SessionManager.IOptions) {
    super(options);

    this._kernelManager = options.kernelManager;

    // Start model polling with exponential backoff.
    this._pollModels = new Poll({
      auto: false,
      factory: () => this.requestRunning(),
      frequency: {
        interval: 10 * 1000,
        backoff: true,
        max: 300 * 1000
      },
      name: `@jupyterlab/services:SessionManager#models`,
      standby: options.standby || 'when-hidden'
    });

    // Initialize internal data.
    this._ready = (async () => {
      await this._pollModels.start();
      await this._pollModels.tick;
      this._isReady = true;
    })();
  }

  /**
   * The server settings for the manager.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * Test whether the manager is ready.
   */
  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * A promise that fulfills when the manager is ready.
   */
  get ready(): Promise<void> {
    return this._ready;
  }

  /**
   * A signal emitted when the running sessions change.
   */
  get runningChanged(): ISignal<this, Session.IModel[]> {
    return this._runningChanged;
  }

  /**
   * A signal emitted when there is a connection failure.
   */
  get connectionFailure(): ISignal<this, Error> {
    return this._connectionFailure;
  }

  /**
   * Dispose of the resources used by the manager.
   */
  dispose(): void {
    this._models.clear();
    this._sessionConnections.forEach(x => x.dispose());
    this._pollModels.dispose();
    super.dispose();
  }

  /*
   * Connect to a running session.  See also [[connectToSession]].
   */
  connectTo(model: Session.IModel): Session.ISessionConnection {
    const sessionConnection = new SessionConnection(
      { ...model, connectToKernel: this._connectToKernel },
      model.id,
      model.kernel
    );
    this._onStarted(sessionConnection);
    if (!this._models.has(model.id)) {
      // We trust the user to connect to an existing session, but we verify
      // asynchronously.
      void this.refreshRunning();
    }

    return sessionConnection;
  }

  /**
   * Create an iterator over the most recent running sessions.
   *
   * @returns A new iterator over the running sessions.
   */
  running(): IIterator<Session.IModel> {
    return iter([...this._models.values()]);
  }

  /**
   * Force a refresh of the running sessions.
   *
   * @returns A promise that with the list of running sessions.
   *
   * #### Notes
   * This is not typically meant to be called by the user, since the
   * manager maintains its own internal state.
   */
  async refreshRunning(): Promise<void> {
    await this._pollModels.refresh();
    await this._pollModels.tick;
  }

  /**
   * Start a new session.  See also [[startNewSession]].
   *
   * @param options - Overrides for the default options, must include a `path`.
   */
  async startNew(
    options: Session.IOptions
  ): Promise<Session.ISessionConnection> {
    const model = await startSession({
      ...options,
      serverSettings: this.serverSettings
    });
    await this.refreshRunning();
    return this.connectTo(model);
  }

  /**
   * Shut down a session by id.
   */
  async shutdown(id: string): Promise<void> {
    await shutdownSession(id, this.serverSettings);
    await this.refreshRunning();
  }

  /**
   * Shut down all sessions.
   *
   * @returns A promise that resolves when all of the kernels are shut down.
   */
  async shutdownAll(): Promise<void> {
    // Update the list of models to make sure our list is current.
    await this.refreshRunning();

    // Shut down all models.
    await Promise.all(
      [...this._models.keys()].map(id =>
        shutdownSession(id, this.serverSettings)
      )
    );

    // Update the list of models to clear out our state.
    await this.refreshRunning();
  }

  /**
   * Find a session associated with a path and stop it if it is the only session
   * using that kernel.
   *
   * @param path - The path in question.
   *
   * @returns A promise that resolves when the relevant sessions are stopped.
   */
  async stopIfNeeded(path: string): Promise<void> {
    try {
      const sessions = await listRunning(this.serverSettings);
      const matches = sessions.filter(value => value.path === path);
      if (matches.length === 1) {
        const id = matches[0].id;
        await this.shutdown(id);
      }
    } catch (error) {
      /* Always succeed. */
    }
  }

  /**
   * Find a session by id.
   */
  async findById(id: string): Promise<Session.IModel> {
    if (this._models.has(id)) {
      return this._models.get(id);
    }
    await this.refreshRunning();
    return this._models.get(id);
  }

  /**
   * Find a session by path.
   */
  async findByPath(path: string): Promise<Session.IModel> {
    for (let m of this._models.values()) {
      if (m.path === path) {
        return m;
      }
    }
    await this.refreshRunning();
    for (let m of this._models.values()) {
      if (m.path === path) {
        return m;
      }
    }
    return undefined;
  }

  /**
   * Execute a request to the server to poll running kernels and update state.
   */
  protected async requestRunning(): Promise<void> {
    let models: Session.IModel[];
    try {
      models = await listRunning(this.serverSettings);
    } catch (err) {
      // Check for a network error, or a 503 error, which is returned
      // by a JupyterHub when a server is shut down.
      if (
        err instanceof ServerConnection.NetworkError ||
        (err.response && err.response.status === 503)
      ) {
        this._connectionFailure.emit(err);
        models = [];
      }
      throw err;
    }

    if (this.isDisposed) {
      return;
    }

    if (
      this._models.size === models.length &&
      every(models, x =>
        JSONExt.deepEqual(
          (this._models.get(x.id) as unknown) as JSONObject,
          (x as unknown) as JSONObject
        )
      )
    ) {
      // Identical models list (presuming models does not contain duplicate
      // ids), so just return
      return;
    }

    this._models = new Map(models.map(x => [x.id, x]));

    this._sessionConnections.forEach(sc => {
      if (this._models.has(sc.id)) {
        sc.update(this._models.get(sc.id));
      } else {
        sc.dispose();
      }
    });

    this._runningChanged.emit(models);
  }

  /**
   * Handle a session starting.
   */
  private _onStarted(sessionConnection: Session.ISessionConnection): void {
    this._sessionConnections.add(sessionConnection);
    sessionConnection.disposed.connect(this._onDisposed);
    sessionConnection.propertyChanged.connect(this._onChanged);
    sessionConnection.kernelChanged.connect(this._onChanged);
  }

  private _isReady = false;
  private _sessionConnections = new Set<Session.ISessionConnection>();
  private _models = new Map<string, Session.IModel>();
  private _pollModels: Poll;
  private _ready: Promise<void>;
  private _runningChanged = new Signal<this, Session.IModel[]>(this);
  private _connectionFailure = new Signal<this, Error>(this);

  // We define these here so they bind `this` correctly
  private readonly _onDisposed = (
    sessionConnection: Session.ISessionConnection
  ) => {
    this._sessionConnections.delete(sessionConnection);
    // A session termination emission could mean the server session is deleted,
    // or that the session JS object is disposed and the session still exists on
    // the server, so we refresh from the server to make sure we reflect the
    // server state.

    void this.refreshRunning();
  };

  private readonly _onChanged = () => {
    void this.refreshRunning();
  };

  private readonly _connectToKernel = (
    model: Kernel.IModel
  ): Kernel.IKernelConnection => this._kernelManager.connectTo(model);

  private _kernelManager: Kernel.IManager;
}

/**
 * The namespace for `SessionManager` class statics.
 */
export namespace SessionManager {
  /**
   * The options used to initialize a SessionManager.
   */
  export interface IOptions extends BaseManager.IOptions {
    /**
     * When the manager stops polling the API. Defaults to `when-hidden`.
     */
    standby?: Poll.Standby;

    /**
     * Kernel Manager
     */
    kernelManager: Kernel.IManager;
  }
}
