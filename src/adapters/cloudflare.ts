import type * as CF from "@cloudflare/workers-types";
import type { DurableObject } from "cloudflare:workers";
import type { AdapterOptions, AdapterInstance, Adapter } from "../adapter.ts";
import type * as web from "../../types/web.ts";
import { env as cfGlobalEnv } from "cloudflare:workers";
import { toBufferLike } from "../utils.ts";
import { adapterUtils, getPeers } from "../adapter.ts";
import { AdapterHookable } from "../hooks.ts";
import { Message } from "../message.ts";
import { Peer, type PeerContext } from "../peer.ts";
import { StubRequest } from "../_request.ts";
import { WSError } from "../error.ts";

type WSDurableObjectStub = CF.DurableObjectStub & {
  webSocketPublish?: (topic: string, data: unknown, opts: any) => Promise<void>;
};

type ResolveDurableStub = (
  req: CF.Request | undefined,
  env: unknown,
  context: CF.ExecutionContext | undefined,
) => WSDurableObjectStub | undefined | Promise<WSDurableObjectStub | undefined>;

export interface CloudflareOptions extends AdapterOptions {
  /**
   * Durable Object binding name from environment.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "$DurableObject"
   */
  bindingName?: string;

  /**
   * Durable Object instance name.
   *
   * **Note:** This option will be ignored if `resolveDurableStub` is provided.
   *
   * @default "crossws"
   */
  instanceName?: string;

  /**
   * Custom function that resolves Durable Object binding to handle the WebSocket upgrade.
   *
   * **Note:** This option will override `bindingName` and `instanceName`.
   */
  resolveDurableStub?: ResolveDurableStub;
}

// https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/

const cloudflareAdapter: Adapter<
  CloudflareDurableAdapter,
  CloudflareOptions
> = (opts = {}) => {
  const hooks = new AdapterHookable(opts);
  const globalPeers = new Map<
    string,
    Set<CloudflareDurablePeer | CloudflareFallbackPeer>
  >();

  const resolveDurableStub: ResolveDurableStub =
    opts.resolveDurableStub ||
    ((_req, env: any, _context): WSDurableObjectStub | undefined => {
      const bindingName = opts.bindingName || "$DurableObject";
      const binding = (env || cfGlobalEnv)[
        bindingName
      ] as CF.DurableObjectNamespace;
      if (binding) {
        const instanceId = binding.idFromName(opts.instanceName || "crossws");
        return binding.get(instanceId);
      }
    });

  const { publish: durablePublish, ...utils } = adapterUtils(globalPeers);

  return {
    ...utils,
    handleUpgrade: async (request, cfEnv, cfCtx) => {
      // Upgrade request with Durable Object binding
      const stub = await resolveDurableStub(
        request as CF.Request,
        cfEnv,
        cfCtx,
      );
      if (stub) {
        return stub.fetch(
          request as CF.Request,
        ) as unknown as Promise<Response>;
      }

      // [Fallback] Upgrade request in same Worker
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request as unknown as Request);
      if (endResponse) {
        return endResponse as unknown as Response;
      }
      const peers = getPeers(
        globalPeers,
        namespace,
      ) as Set<CloudflareFallbackPeer>;
      const pair = new WebSocketPair() as unknown as [
        CF.WebSocket,
        CF.WebSocket,
      ];
      const client = pair[0];
      const server = pair[1];
      const peer = new CloudflareFallbackPeer({
        ws: client,
        peers,
        wsServer: server,
        request: request as unknown as Request,
        cfEnv,
        cfCtx,
        context,
        namespace,
      });
      peers.add(peer);
      server.accept();
      hooks.callHook("open", peer);
      server.addEventListener("message", (event) => {
        hooks.callHook(
          "message",
          peer,
          new Message(event.data, peer, event as MessageEvent),
        );
      });
      server.addEventListener("error", (event) => {
        peers.delete(peer);
        hooks.callHook("error", peer, new WSError(event.error));
      });
      server.addEventListener("close", (event) => {
        peers.delete(peer);
        hooks.callHook("close", peer, event);
      });
      // eslint-disable-next-line unicorn/no-null
      return new Response(null, {
        status: 101,
        webSocket: client as unknown as WebSocket,
        headers: upgradeHeaders,
      }) as unknown as Response;
    },
    handleDurableInit: async (obj, state, env) => {
      // placeholder
    },
    handleDurableUpgrade: async (obj, request) => {
      const { upgradeHeaders, endResponse, context, namespace } =
        await hooks.upgrade(request as Request);
      if (endResponse) {
        return endResponse;
      }

      const peers = getPeers(globalPeers, namespace);

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const peer = CloudflareDurablePeer._restore(
        obj,
        server as unknown as CF.WebSocket,
        request,
        namespace,
      );
      peers.add(peer);
      (obj as DurableObjectPub).ctx.acceptWebSocket(server);

      await (obj as DurableObjectPub).ctx.storage.put(
        `_context:${peer.id}`,
        context,
      );

      await (obj as DurableObjectPub).ctx.storage.put(
        `_namespace:${peer.id}`,
        namespace,
      );

      await hooks.callHook("open", peer);

      // eslint-disable-next-line unicorn/no-null
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: upgradeHeaders,
      });
    },
    handleDurableMessage: async (obj, ws, message) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      await peer._loadStorage();
      await hooks.callHook("message", peer, new Message(message, peer));
    },
    handleDurableClose: async (obj, ws, code, reason, wasClean) => {
      const peer = CloudflareDurablePeer._restore(obj, ws as CF.WebSocket);
      await peer._loadStorage();
      const peers = getPeers(globalPeers, peer.namespace);
      peers.delete(peer);
      const details = { code, reason, wasClean };
      await hooks.callHook("close", peer, details);

      await (obj as DurableObjectPub).ctx.storage.deleteAlarm();
      await (obj as DurableObjectPub).ctx.storage.deleteAll();
    },
    handleDurablePublish: async (_obj, topic, data, opts) => {
      return durablePublish(topic, data, opts);
    },
    publish: async (topic, data, opts) => {
      const stub = await resolveDurableStub(undefined, cfGlobalEnv, undefined);
      if (!stub) {
        throw new Error("[crossws] Durable Object binding cannot be resolved.");
      }
      // - Compatibility date >= 2024-04-03 or "rpc" feature flag is required
      // - We cannot check if webSocketPublish is exposed or not without RPC call
      try {
        return await stub.webSocketPublish!(topic, data, opts);
      } catch (error) {
        console.error(error);
        throw error;
      }
    },
  };
};

export default cloudflareAdapter;

// --- peer ---

class CloudflareDurablePeer extends Peer<{
  ws: AugmentedWebSocket;
  request: Request;
  peers?: never;
  namespace: string;
  context?: PeerContext;
  durable: DurableObjectPub;
}> {
  override get peers() {
    return new Set(
      this.#getwebsockets().map((ws) =>
        CloudflareDurablePeer._restore(this._internal.durable, ws),
      ),
    );
  }

  #getwebsockets() {
    return this._internal.durable.ctx.getWebSockets() as unknown as (typeof this._internal.ws)[];
  }

  async _loadStorage() {
    const context = await this._internal.durable.ctx.storage.get<PeerContext>(
      `_context:${this.id}`,
    );
    if (context) this._internal.context = context;

    const namespace = await this._internal.durable.ctx.storage.get<string>(
      `_namespace:${this.id}`,
    );
    if (namespace) this._internal.namespace = namespace;
  }

  send(data: unknown) {
    return this._internal.ws.send(toBufferLike(data));
  }

  override subscribe(topic: string): void {
    super.subscribe(topic);
    const state = getAttachedState(this._internal.ws);
    if (!state.t) {
      state.t = new Set();
    }
    state.t.add(topic);
    setAttachedState(this._internal.ws, state);
  }

  publish(topic: string, data: unknown): void {
    const websockets = this.#getwebsockets();
    if (websockets.length < 2 /* 1 is self! */) {
      return;
    }
    const dataBuff = toBufferLike(data);
    for (const ws of websockets) {
      if (ws === this._internal.ws) {
        continue;
      }
      const state = getAttachedState(ws);
      if (state.t?.has(topic)) {
        ws.send(dataBuff);
      }
    }
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
  }

  static _restore(
    durable: DurableObject,
    ws: AugmentedWebSocket,
    request?: Request | CF.Request,
    namespace?: string,
  ): CloudflareDurablePeer {
    let peer = ws._crosswsPeer;
    if (peer) {
      return peer;
    }
    const state = (ws.deserializeAttachment() || {}) as AttachedState;
    peer = ws._crosswsPeer = new CloudflareDurablePeer({
      ws: ws as CF.WebSocket,
      request:
        (request as Request | undefined) || new StubRequest(state.u || ""),
      namespace: namespace || state.n || "" /* later throws error if empty */,
      durable: durable as DurableObjectPub,
    });
    if (state.i) {
      peer._id = state.i;
    }
    if (request?.url) {
      state.u = request.url;
    }
    state.i = peer.id;
    state.n = peer.namespace;
    setAttachedState(ws, state);
    return peer;
  }
}

class CloudflareFallbackPeer extends Peer<{
  ws: CF.WebSocket;
  request: Request;
  peers: Set<CloudflareFallbackPeer>;
  wsServer: CF.WebSocket;
  cfEnv: unknown;
  cfCtx: CF.ExecutionContext;
  context: PeerContext;
  namespace: string;
}> {
  send(data: unknown) {
    this._internal.wsServer.send(toBufferLike(data));
    return 0;
  }

  publish(_topic: string, _message: any): void {
    console.warn(
      "[crossws] [cloudflare] pub/sub support requires Durable Objects.",
    );
  }

  close(code?: number, reason?: string) {
    this._internal.ws.close(code, reason);
  }
}

// -- attached state utils ---

function getAttachedState(ws: AugmentedWebSocket): AttachedState {
  let state = ws._crosswsState;
  if (state) {
    return state;
  }
  state = (ws.deserializeAttachment() as AttachedState) || {};
  ws._crosswsState = state;
  return state;
}

function setAttachedState(ws: AugmentedWebSocket, state: AttachedState) {
  ws._crosswsState = state;
  ws.serializeAttachment(state);
}

// --- types ---

declare class DurableObjectPub extends DurableObject {
  public ctx: DurableObject["ctx"];
  public env: unknown;
}

type AugmentedWebSocket = CF.WebSocket & {
  _crosswsPeer?: CloudflareDurablePeer;
  _crosswsState?: AttachedState;
};

/** Max serialized limit: 2048 bytes (512..2048 characters) */
type AttachedState = {
  /** Subscribed topics */
  t?: Set<string>;
  /** Peer id */
  i?: string;
  /** Request url */
  u?: string;
  /** Connection namespace */
  n?: string;
};

export interface CloudflareDurableAdapter extends AdapterInstance {
  handleUpgrade(
    req: Request | CF.Request,
    env: unknown,
    context: CF.ExecutionContext,
  ): Promise<Response>;

  handleDurableInit(
    obj: DurableObject,
    state: DurableObjectState,
    env: unknown,
  ): void;

  handleDurableUpgrade(
    obj: DurableObject,
    req: Request | CF.Request,
  ): Promise<Response>;

  handleDurableMessage(
    obj: DurableObject,
    ws: WebSocket | CF.WebSocket | web.WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void>;

  handleDurablePublish: (
    obj: DurableObject,
    topic: string,
    data: unknown,
    opts: any,
  ) => Promise<void>;

  handleDurableClose(
    obj: DurableObject,
    ws: WebSocket | CF.WebSocket | web.WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
}
