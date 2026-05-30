import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import type { Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Headers = Record<string, string>;

type Packet = {
  type: string;
  headers: Headers;
  body: unknown;
};

type OnlineUser = {
  id: string;
  ip: string;
  port: number;
};

type ChatBody = {
  from: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOnlineUser(value: unknown): value is OnlineUser {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["ip"] === "string" &&
    typeof value["port"] === "number"
  );
}

function getOnlineUsers(body: unknown): OnlineUser[] | null {
  if (!isRecord(body) || !Array.isArray(body["users"])) {
    return null;
  }

  return body["users"].filter(isOnlineUser);
}

function getUser(body: unknown): OnlineUser | null {
  if (!isRecord(body) || !isOnlineUser(body["user"])) {
    return null;
  }

  return body["user"];
}

function getChat(body: unknown): ChatBody | null {
  if (
    !isRecord(body) ||
    typeof body["from"] !== "string" ||
    typeof body["message"] !== "string"
  ) {
    return null;
  }

  return {
    from: body["from"],
    message: body["message"],
  };
}

function encodePacket(type: string, body: unknown): string {
  const bodyText = JSON.stringify(body);
  const contentLength = Buffer.byteLength(bodyText, "utf8");

  return [
    `Type: ${type}`,
    "Content-Type: application/json",
    `Content-Length: ${contentLength}`,
    "",
    bodyText,
  ].join("\r\n");
}

class PacketReader {
  private _buffer = "";
  private readonly _onPacket: (packet: Packet) => void;

  public constructor(onPacket: (packet: Packet) => void) {
    this._onPacket = onPacket;
  }

  public push(data: string): void {
    this._buffer += data;

    while (true) {
      const headerEndIndex = this._buffer.indexOf("\r\n\r\n");
      if (headerEndIndex === -1) {
        return;
      }

      const headerText = this._buffer.slice(0, headerEndIndex);
      const headers = this._parseHeaders(headerText);
      const contentLength = Number(headers["content-length"] ?? "0");

      if (!Number.isInteger(contentLength) || contentLength < 0) {
        this._buffer = "";
        return;
      }

      const bodyStartIndex = headerEndIndex + 4;
      const packetEndIndex = bodyStartIndex + contentLength;
      if (this._buffer.length < packetEndIndex) {
        return;
      }

      const bodyText = this._buffer.slice(bodyStartIndex, packetEndIndex);
      this._buffer = this._buffer.slice(packetEndIndex);

      const type = headers["type"];
      if (type === undefined) {
        continue;
      }

      try {
        const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
        this._onPacket({ type, headers, body });
      } catch {
        console.error("invalid packet body");
      }
    }
  }

  private _parseHeaders(headerText: string): Headers {
    const headers: Headers = {};

    for (const line of headerText.split("\r\n")) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = line.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }

    return headers;
  }
}

class LoginServer {
  private static readonly ONLINE_USERS_FILE = path.join(process.cwd(), "online_users.json");

  private readonly _server: net.Server;
  private readonly _clients = new Map<net.Socket, OnlineUser>();

  public constructor() {
    this._server = net.createServer(this._handleConnection.bind(this));

    this._server.on("error", (err) => {
      console.error("server error:", err);
    });

    this._saveOnlineUsers();
  }

  private _handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");

    const reader = new PacketReader((packet) => {
      this._handlePacket(socket, packet);
    });

    socket.on("data", (data) => {
      reader.push(String(data));
    });

    socket.on("close", () => {
      this._removeClient(socket);
    });

    socket.on("error", (err) => {
      console.error("socket error:", err.message);
    });
  }

  private _handlePacket(socket: net.Socket, packet: Packet): void {
    if (packet.type === "LOGIN") {
      this._handleLogin(socket, packet.body);
      return;
    }

    if (packet.type === "PONG") {
      return;
    }

    this._send(socket, "ERROR", { message: `unsupported packet type: ${packet.type}` });
  }

  private _handleLogin(socket: net.Socket, body: unknown): void {
    if (!isOnlineUser(body)) {
      this._send(socket, "ERROR", { message: "LOGIN body must be { id, ip, port }" });
      socket.end();
      return;
    }

    if (this._findUserByID(body.id) !== null) {
      this._send(socket, "ERROR", { message: `duplicated id: ${body.id}` });
      socket.end();
      return;
    }

    const currentUsers = this._getOnlineUsers();
    this._clients.set(socket, body);
    this._saveOnlineUsers();

    this._send(socket, "ONLINE_USERS", { users: currentUsers });
    this._broadcast("USER_JOINED", { user: body }, socket);

    console.log(`login: ${body.id} ${body.ip}:${body.port}`);
  }

  private _removeClient(socket: net.Socket): void {
    const user = this._clients.get(socket);
    if (user === undefined) {
      return;
    }

    this._clients.delete(socket);
    this._saveOnlineUsers();
    this._broadcast("USER_LEFT", { user }, socket);

    console.log(`logout: ${user.id}`);
  }

  private _findUserByID(id: string): OnlineUser | null {
    for (const user of this._clients.values()) {
      if (user.id === id) {
        return user;
      }
    }

    return null;
  }

  private _getOnlineUsers(): OnlineUser[] {
    return [...this._clients.values()];
  }

  private _saveOnlineUsers(): void {
    fs.writeFileSync(
      LoginServer.ONLINE_USERS_FILE,
      `${JSON.stringify(this._getOnlineUsers(), null, 2)}\n`,
      "utf8",
    );
  }

  private _broadcast(type: string, body: unknown, exceptSocket?: net.Socket): void {
    for (const socket of this._clients.keys()) {
      if (socket === exceptSocket) {
        continue;
      }

      this._send(socket, type, body);
    }
  }

  private _send(socket: net.Socket, type: string, body: unknown): void {
    socket.write(encodePacket(type, body));
  }

  public listen(port: number): void {
    this._server.listen(port, "0.0.0.0", () => {
      console.log(`login server listening on ${port}`);
      console.log(`online users file: ${LoginServer.ONLINE_USERS_FILE}`);
    });
  }
}

class Client {
  private readonly _loginID: string;
  private readonly _peerIP: string;
  private readonly _peerPort: number;
  private readonly _peerServer: net.Server;
  private readonly _peers = new Map<string, net.Socket>();

  public constructor(loginServerPort: number, loginID: string, peerIP: string, peerPort: number) {
    this._loginID = loginID;
    this._peerIP = peerIP;
    this._peerPort = peerPort;

    this._peerServer = net.createServer(this._handlePeerConnection.bind(this));
    this._peerServer.on("error", (err) => {
      console.error("peer server error:", err.message);
    });

    this._peerServer.listen(peerPort, "0.0.0.0", () => {
      console.log(`peer server listening on ${peerIP}:${peerPort}`);
      this._connectLoginServer(loginServerPort);
    });
  }

  private _connectLoginServer(loginServerPort: number): void {
    const socket = net.createConnection({ host: "127.0.0.1", port: loginServerPort }, () => {
      this._send(socket, "LOGIN", this._myInfo());
    });

    socket.setEncoding("utf8");

    const reader = new PacketReader((packet) => {
      this._handleLoginServerPacket(packet);
    });

    socket.on("data", (data) => {
      reader.push(String(data));
    });

    socket.on("close", () => {
      console.log("login server connection closed");
    });

    socket.on("error", (err) => {
      console.error("login server socket error:", err.message);
    });
  }

  private _handleLoginServerPacket(packet: Packet): void {
    if (packet.type === "ONLINE_USERS") {
      this._handleOnlineUsers(packet.body);
      return;
    }

    if (packet.type === "USER_JOINED") {
      this._handleUserJoined(packet.body);
      return;
    }

    if (packet.type === "USER_LEFT") {
      this._handleUserLeft(packet.body);
      return;
    }

    if (packet.type === "ERROR") {
      console.error("login server error:", packet.body);
      return;
    }

    console.log("from login server:", packet);
  }

  private _handleOnlineUsers(body: unknown): void {
    const onlineUsers = getOnlineUsers(body);
    if (onlineUsers === null) {
      console.error("invalid ONLINE_USERS body");
      return;
    }

    console.log("online users:", onlineUsers);

    for (const user of onlineUsers) {
      this._connectPeer(user);
    }
  }

  private _handleUserJoined(body: unknown): void {
    const user = getUser(body);
    if (user === null) {
      console.error("invalid USER_JOINED body");
      return;
    }

    console.log(`user joined: ${user.id} ${user.ip}:${user.port}`);
  }

  public sendChat(peerID: string, message: string): boolean {
    const socket = this._peers.get(peerID);
    if (socket === undefined) {
      return false;
    }

    this._send(socket, "CHAT", {
      from: this._loginID,
      message,
    });

    return true;
  }

  public getPeerIDs(): string[] {
    return [...this._peers.keys()];
  }

  private _handleUserLeft(body: unknown): void {
    const user = getUser(body);
    if (user === null) {
      console.error("invalid USER_LEFT body");
      return;
    }

    const socket = this._peers.get(user.id);
    if (socket !== undefined) {
      socket.end();
      this._peers.delete(user.id);
    }

    console.log(`user left: ${user.id}`);
  }

  private _handlePeerConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    this._setupPeerSocket(socket, null);
  }

  private _connectPeer(user: OnlineUser): void {
    if (user.id === this._loginID || this._peers.has(user.id)) {
      return;
    }

    const socket = net.createConnection({ host: user.ip, port: user.port }, () => {
      this._send(socket, "PEER_HELLO", { user: this._myInfo() });
      console.log(`connected to peer: ${user.id}`);
    });

    socket.setEncoding("utf8");
    this._setupPeerSocket(socket, user.id);
  }

  private _setupPeerSocket(socket: net.Socket, initialPeerID: string | null): void {
    let peerID = initialPeerID;

    if (peerID !== null) {
      this._peers.set(peerID, socket);
    }

    const reader = new PacketReader((packet) => {
      if (packet.type === "PEER_HELLO") {
        peerID = this._handlePeerHello(socket, packet.body);
        return;
      }

      if (packet.type === "CHAT") {
        this._handleChat(packet.body);
        return;
      }

      console.log("from peer:", packet);
    });

    socket.on("data", (data) => {
      reader.push(String(data));
    });

    socket.on("close", () => {
      if (peerID !== null && this._peers.get(peerID) === socket) {
        this._peers.delete(peerID);
      }
    });

    socket.on("error", (err) => {
      console.error("peer socket error:", err.message);
    });
  }

  private _handlePeerHello(socket: net.Socket, body: unknown): string | null {
    const user = getUser(body);
    if (user === null) {
      console.error("invalid PEER_HELLO body");
      return null;
    }

    this._peers.set(user.id, socket);
    console.log(`peer joined: ${user.id}`);

    return user.id;
  }

  private _handleChat(body: unknown): void {
    const chatBody = getChat(body);
    if (chatBody === null) {
      console.error("invalid CHAT body");
      return;
    }

    console.log(`[${chatBody.from}] ${chatBody.message}`);
  }

  private _myInfo(): OnlineUser {
    return {
      id: this._loginID,
      ip: this._peerIP,
      port: this._peerPort,
    };
  }

  private _send(socket: net.Socket, type: string, body: unknown): void {
    socket.write(encodePacket(type, body));
  }
}

async function runChatInput(rl: Interface, client: Client): Promise<void> {
  console.log("chat command: @peerID message, /peers, /quit");

  while (true) {
    const line = await rl.question("> ");
    const trimmedLine = line.trim();

    if (trimmedLine === "") {
      continue;
    }

    if (trimmedLine === "/quit") {
      rl.close();
      return;
    }

    if (trimmedLine === "/peers") {
      console.log("peers:", client.getPeerIDs());
      continue;
    }

    if (!trimmedLine.startsWith("@")) {
      console.log("use: @peerID message");
      continue;
    }

    const firstSpaceIndex = trimmedLine.indexOf(" ");
    if (firstSpaceIndex === -1) {
      console.log("use: @peerID message");
      continue;
    }

    const peerID = trimmedLine.slice(1, firstSpaceIndex);
    const message = trimmedLine.slice(firstSpaceIndex + 1).trim();

    if (peerID === "" || message === "") {
      console.log("use: @peerID message");
      continue;
    }

    const sent = client.sendChat(peerID, message);
    if (!sent) {
      console.log(`peer not connected: ${peerID}`);
    }
  }
}

async function main(): Promise<void> {
  const initParam = process.argv[2];

  if (initParam === undefined) {
    console.log("init param required: s(server) or c(client)");
    return;
  }

  const loginServerPort = 8000;

  if (initParam === "s") {
    const server = new LoginServer();
    server.listen(loginServerPort);
    return;
  }

  if (initParam === "c") {
    const rl = readline.createInterface({ input, output });
    const loginID = await rl.question("Enter your login ID: ");
    const peerIPInput = await rl.question("Enter your peer IP [127.0.0.1]: ");
    const peerPortInput = await rl.question("Enter your peer port: ");

    const peerIP = peerIPInput.trim() === "" ? "127.0.0.1" : peerIPInput.trim();
    const peerPort = Number(peerPortInput);

    if (loginID.trim() === "" || !Number.isInteger(peerPort) || peerPort <= 0) {
      console.log("invalid client input");
      rl.close();
      return;
    }

    const client = new Client(loginServerPort, loginID.trim(), peerIP, peerPort);
    await runChatInput(rl, client);
    return;
  }

  console.log("invalid init param");
}

main();
