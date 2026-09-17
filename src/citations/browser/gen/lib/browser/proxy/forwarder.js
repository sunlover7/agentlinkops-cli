import {
  request as httpRequest
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
const SOCKET_TIMEOUT_MS = 3e4;
function buildBasicAuthHeader(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const token = Buffer.from(
    `${proxy.username ?? ""}:${proxy.password ?? ""}`
  ).toString("base64");
  return `Basic ${token}`;
}
function sanitizeHeaders(headers) {
  const nextHeaders = { ...headers };
  delete nextHeaders["proxy-authorization"];
  delete nextHeaders["proxy-connection"];
  delete nextHeaders["Proxy-Authorization"];
  delete nextHeaders["Proxy-Connection"];
  return nextHeaders;
}
function formatHttpTarget(request) {
  if (!request.url) {
    throw new Error("Proxy request missing URL");
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(request.url)) {
    return new URL(request.url);
  }
  if (!request.headers.host) {
    throw new Error("Proxy request missing Host header");
  }
  return new URL(`http://${request.headers.host}${request.url}`);
}
function parseAuthority(authority) {
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket === -1) {
      throw new Error(`Invalid authority: ${authority}`);
    }
    const host2 = authority.slice(1, closingBracket);
    const portPart = authority.slice(closingBracket + 1);
    const port2 = portPart.startsWith(":") ? Number(portPart.slice(1)) : 443;
    if (!Number.isFinite(port2)) {
      throw new Error(`Invalid authority port: ${authority}`);
    }
    return { host: host2, port: port2 };
  }
  const separator = authority.lastIndexOf(":");
  if (separator === -1) {
    return { host: authority, port: 443 };
  }
  const host = authority.slice(0, separator);
  const port = Number(authority.slice(separator + 1));
  if (!host || !Number.isFinite(port)) {
    throw new Error(`Invalid authority: ${authority}`);
  }
  return { host, port };
}
function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      socket.setNoDelay(true);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        socket.destroy(new Error("socket timeout"));
      });
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("connect", onConnect);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}
function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      servername: host,
      // Proxy providers (e.g. BrightData) may use custom CA certs.
      // rejectUnauthorized applies only to the proxy TLS hop, not to the
      // end-to-end TLS inside the CONNECT tunnel (which the browser validates).
      rejectUnauthorized: false
    });
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onSecureConnect = () => {
      cleanup();
      socket.setNoDelay(true);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        socket.destroy(new Error("socket timeout"));
      });
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("secureConnect", onSecureConnect);
    };
    socket.once("error", onError);
    socket.once("secureConnect", onSecureConnect);
  });
}
function readUntilAny(socket, ...delimiters) {
  return new Promise((resolve, reject) => {
    const delimiterBuffers = delimiters.map((d) => Buffer.from(d));
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const payload = Buffer.concat(chunks, total);
      for (const delimiterBuffer of delimiterBuffers) {
        const index = payload.indexOf(delimiterBuffer);
        if (index === -1) continue;
        cleanup();
        const end = index + delimiterBuffer.length;
        const head = payload.subarray(0, end);
        const tail = payload.subarray(end);
        if (tail.length > 0) {
          socket.unshift(tail);
        }
        resolve(head);
        return;
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before response headers were received"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
async function createTunnelSocket(proxy, targetHost, targetPort) {
  const socket = proxy.scheme === "https" ? await connectTls(proxy.host, proxy.port) : await connectTcp(proxy.host, proxy.port);
  const authHeader = buildBasicAuthHeader(proxy);
  const requestLines = [
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
    `Host: ${targetHost}:${targetPort}`,
    "Proxy-Connection: Keep-Alive"
  ];
  if (authHeader) {
    requestLines.push(`Proxy-Authorization: ${authHeader}`);
  }
  requestLines.push("", "");
  socket.write(requestLines.join("\r\n"));
  const responseHead = await readUntilAny(socket, "\r\n\r\n", "\n\n");
  const statusLine = responseHead.toString("latin1").split(/\r?\n/, 1)[0] ?? "";
  if (!/^HTTP\/1\.[01] 200\b/i.test(statusLine)) {
    socket.destroy();
    throw new Error(`Proxy CONNECT failed: ${statusLine || "no response"}`);
  }
  return socket;
}
function handleProxyError(response, statusCode, error) {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : void 0);
    return;
  }
  response.writeHead(statusCode, { "Content-Type": "text/plain" });
  response.end(error instanceof Error ? error.message : "proxy error");
}
async function handleHttpProxyRequest(request, response, proxy, trackSocket) {
  const target = formatHttpTarget(request);
  const proxyAuthHeader = buildBasicAuthHeader(proxy);
  const transport = proxy.scheme === "https" ? httpsRequest : httpRequest;
  const upstreamRequest = transport(
    {
      host: proxy.host,
      port: proxy.port,
      method: request.method,
      path: target.toString(),
      headers: {
        ...sanitizeHeaders(request.headers),
        ...proxyAuthHeader ? { "Proxy-Authorization": proxyAuthHeader } : {}
      },
      agent: false,
      // Proxy providers may use custom CA certs; only disable for proxy hop.
      rejectUnauthorized: false
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        upstreamResponse.headers
      );
      upstreamResponse.pipe(response);
    }
  );
  upstreamRequest.on("socket", (socket) => {
    trackSocket(socket);
  });
  upstreamRequest.on("error", (error) => {
    handleProxyError(response, 502, error);
  });
  request.pipe(upstreamRequest);
}
function relaySockets(clientSocket, upstreamSocket) {
  const destroyPair = () => {
    clientSocket.destroy();
    upstreamSocket.destroy();
  };
  clientSocket.on("error", destroyPair);
  upstreamSocket.on("error", destroyPair);
  clientSocket.on("close", () => upstreamSocket.destroy());
  upstreamSocket.on("close", () => clientSocket.destroy());
  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);
}
function checkProxyReachable(host, port, timeoutMs = 2e3) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
export {
  checkProxyReachable
};
