// Relay transport for the web build.
//
// Cloudflare only serves relays.cbgames.org over https, and a wisp proxy just opens plain
// TCP, so the browser cannot reach it through a tunnel with the built-in WebSocket. epoxy-tls
// runs a real TLS stack in WebAssembly over the tunnel, which is what makes the Worker relay
// reachable through a wisp server.
//
//   ?wisp=<url>[,<url>...]  wisp endpoint(s) to tunnel through, tried in order
//                           accepts any form: host, host/wi, wss://host/wi/, ...
//   ?relay=<ws(s)://...>    relay to open (wins over YOMI_RELAY_URL)
//   ?wispv=1|2              force a wisp protocol version (auto-negotiated by default)
//   ?nowisp=1               talk to the relay directly, no tunnel
//   ?relayDebug             log relay handshake traffic
(() => {
  const params = new URLSearchParams(window.location.search);
  // Tried in order: the first endpoint that completes a tunnel is used.
  const DEFAULT_WISP = "wss://girlspreples.org/wi/,wss://snoopy.easternstamps.com/wisp/";
  const DEFAULT_RELAY = "wss://relays.cbgames.org/yomihustle/";
  const relayUrl = params.get("relay") || window.YOMI_RELAY_URL || DEFAULT_RELAY;
  const nowisp = params.has("nowisp");
  const debug = params.has("relayDebug");

  function normalizeWisp(raw) {
    let value = String(raw || "").trim();
    if (!value) return "";
    if (!/^wss?:\/\//i.test(value)) value = "wss://" + value.replace(/^\/+/, "");
    if (!/\/[^/]*$/.test(value) || value.endsWith("/")) return value.endsWith("/") ? value : value + "/";
    return value + "/";
  }

  const WISP_CANDIDATES = String(params.get("wisp") || window.YOMI_WISP_URL || DEFAULT_WISP)
    .split(",")
    .map(normalizeWisp)
    .filter(Boolean);

  const forcedVersion = params.get("wispv");
  const versionOrder = () => {
    if (forcedVersion === "2") return [true];
    if (forcedVersion === "1") return [false];
    // Unknown server software: try v1 first (what stock servers speak), then v2.
    return [false, true];
  };

  window.YOMI_RELAY_URL = relayUrl;
  window.YOMI_WISP_URL = WISP_CANDIDATES[0] || "";

  const NativeWebSocket = window.WebSocket;

  function trace(direction, data) {
    if (!debug || typeof data !== "string") return;
    try {
      const message = JSON.parse(data);
      if (["welcome", "create_match", "match_created", "player_join_game", "room_join_confirm", "room_join_deny"].includes(message.type)) {
        console.info("YOMI relay", direction, JSON.stringify(message));
      }
    } catch {}
  }

  function isRelay(target) {
    return (
      target.hostname === "relays.cbgames.org" ||
      target.pathname.startsWith("/yomihustle") ||
      target.pathname === "/relay" ||
      target.pathname.startsWith("/relay/")
    );
  }

  // epoxy hands back strings for text frames and byte views for binary ones;
  // Godot's glue only understands ArrayBuffer or string.
  function toEventData(payload) {
    if (typeof payload === "string") return payload;
    if (payload instanceof ArrayBuffer) return payload;
    if (ArrayBuffer.isView(payload)) return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    return String(payload);
  }

  function toPayload(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return String(data);
  }

  let epoxyModule = null;
  let epoxyLoad = null;
  const epoxyClients = new Map();

  function loadEpoxy() {
    if (!epoxyLoad) {
      epoxyLoad = import("./epoxy-bundled.js")
        .then(async (mod) => {
          await mod.default();
          epoxyModule = mod;
          return mod;
        })
        .catch((error) => {
          epoxyLoad = null;
          throw error;
        });
    }
    return epoxyLoad;
  }

  async function clientFor(wisp, v2) {
    const mod = await loadEpoxy();
    const key = wisp + (v2 ? "|2" : "|1");
    let client = epoxyClients.get(key);
    if (!client) {
      const options = new mod.EpoxyClientOptions();
      options.wisp_v2 = v2;
      options.udp_extension_required = false;
      options.disable_certificate_validation = false;
      client = new mod.EpoxyClient(wisp, options);
      epoxyClients.set(key, client);
    }
    return client;
  }

  class RelaySocket {
    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols;
      this.binaryType = "arraybuffer";
      this.readyState = 0;
      this.protocol = "";
      this.bufferedAmount = 0;
      this.CONNECTING = 0;
      this.OPEN = 1;
      this.CLOSING = 2;
      this.CLOSED = 3;
      this.tunnel = "";
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._socket = null;
      this._queue = [];
      this._incoming = [];
      this._heartbeat = 0;
      this._openTimer = 0;
      this._open(url, protocols);
    }

    _handlers() {
      const mod = epoxyModule;
      return mod
        ? new mod.EpoxyHandlers(
            () => {},
            () => this._closed(1000, "", false),
            (error) => {
              console.error("YOMI relay socket error: " + error);
              if (this.onerror) this.onerror({ message: String(error) });
            },
            (payload) => {
              if (this.readyState === 2 || this.readyState === 3) return;
              const data = toEventData(payload);
              trace("receive", data);
              if (this.readyState === 0) {
                // A frame arriving proves the tunnel carries traffic in both directions.
                // Anything sent before that can sit in the tunnel for seconds, so this is
                // the real "connected" moment (the relay greets us right after the upgrade).
                this._incoming.push(data);
                this._finalize();
                return;
              }
              if (this.onmessage) this.onmessage({ data });
            }
          )
        : null;
    }

    async _open(url, protocols) {
      const failures = [];
      for (const wisp of WISP_CANDIDATES) {
        for (const v2 of versionOrder()) {
          if (this.readyState === 3) return;
          let socket = null;
          try {
            const client = await clientFor(wisp, v2);
            const handlers = this._handlers();
            if (!handlers) throw new Error("epoxy module unavailable");
            socket = await client.connect_websocket(handlers, url, protocols || [], {});
          } catch (error) {
            failures.push(wisp + (v2 ? " v2" : " v1") + ": " + (error && error.message ? error.message : error));
            continue;
          }
          this.tunnel = wisp + (v2 ? " (wisp v2)" : " (wisp v1)");
          window.YOMI_WISP_URL = wisp;
          console.info("YOMI relay: tunnel via " + this.tunnel);
          this._socket = socket;
          if (this.readyState === 3) {
            socket.close(1000, "").catch(() => {});
            return;
          }
          this._opened();
          return;
        }
      }
      console.error("YOMI relay: no wisp endpoint worked:\n  " + failures.join("\n  "));
      if (this.readyState !== 3) {
        if (this.onerror) this.onerror({ message: "no wisp endpoint worked" });
        this._closed(1006, "tunnel failed", true);
      }
    }

    // Only called once the socket exists, so nothing queued during the handshake can be
    // lost or sent before the stream is writable. Opening waits for the relay's first frame
    // (see the message handler); the timer covers a server that stays silent.
    _opened() {
      if (this.readyState !== 0) return;
      this._openTimer = window.setTimeout(() => this._finalize(), 1500);
      // Warm the tunnel: the relay answers this, so the game's first real message is not the
      // one that pays for the connection being newly established.
      this._send('{"type":"fetch_player_count"}');
    }

    _finalize() {
      if (this.readyState !== 0) return;
      window.clearTimeout(this._openTimer);
      this.readyState = 1;
      this._flush();
      this._heartbeat = window.setInterval(() => {
        if (this.readyState !== 1) return window.clearInterval(this._heartbeat);
        this._send('{"type":"fetch_player_count"}');
      }, 20000);
      if (this.onopen) this.onopen({});
      const buffered = this._incoming;
      this._incoming = [];
      for (const data of buffered) {
        if (this.readyState !== 1) return;
        if (this.onmessage) this.onmessage({ data });
      }
    }

    _closed(code, reason, fireError) {
      if (this.readyState === 3) return;
      window.clearTimeout(this._openTimer);
      window.clearInterval(this._heartbeat);
      this.readyState = 3;
      if (fireError && this.onerror) this.onerror({ message: reason });
      if (this.onclose) this.onclose({ code, reason, wasClean: code !== 1006 });
    }

    _flush() {
      if (!this._socket || !this._queue.length) return;
      const queued = this._queue;
      this._queue = [];
      for (const payload of queued) this._send(payload);
    }

    _send(payload) {
      if (!this._socket) {
        this._queue.push(payload);
        return;
      }
      try {
        const result = this._socket.send(payload);
        if (result && typeof result.catch === "function") result.catch((error) => console.error("YOMI relay send failed: " + error));
      } catch (error) {
        console.error("YOMI relay send failed: " + error);
      }
    }

    send(data) {
      if (this.readyState === 3 || this.readyState === 2) return;
      trace("send", data);
      const payload = toPayload(data);
      if (this.readyState === 1) this._send(payload);
      else this._queue.push(payload);
    }

    close(code = 1000, reason = "") {
      if (this.readyState === 3) return;
      this.readyState = 2;
      window.clearTimeout(this._openTimer);
      window.clearInterval(this._heartbeat);
      if (this._socket) this._socket.close(code, reason).catch(() => {});
      this._closed(code, reason, false);
    }
  }

  function YomiWebSocket(url, protocols) {
    const target = new URL(String(url), window.location.href);
    if (!nowisp && isRelay(target)) return new RelaySocket(String(url), protocols);
    return new NativeWebSocket(url, protocols);
  }
  YomiWebSocket.CONNECTING = 0;
  YomiWebSocket.OPEN = 1;
  YomiWebSocket.CLOSING = 2;
  YomiWebSocket.CLOSED = 3;
  YomiWebSocket.prototype = NativeWebSocket.prototype;

  window.WebSocket = YomiWebSocket;
  // The untouched browser socket, for tools that want to compare against a direct connection.
  window.YOMI_NATIVE_WEBSOCKET = NativeWebSocket;
})();
