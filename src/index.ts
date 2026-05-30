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
    value["id"].trim() !== "" &&
    typeof value["ip"] === "string" &&
    value["ip"].trim() !== "" &&
    typeof value["port"] === "number" &&
    Number.isInteger(value["port"]) &&
    value["port"] > 0
  );
}

function getOnlineUsers(body: unknown): OnlineUser[] | null {
  if (!isRecord(body) || !Array.isArray(body["users"])) {
    return null;
  }

  const users = body["users"];
  if (!users.every(isOnlineUser)) {
    return null;
  }

  return users;
}

function getUser(body: unknown): OnlineUser | null {
  if (!isRecord(body) || !isOnlineUser(body["user"])) {
    return null;
  }

  return body["user"];
}

function getFrom(body: unknown): string | null {
  if (!isRecord(body) || typeof body["from"] !== "string" || body["from"].trim() === "") {
    return null;
  }

  return body["from"];
}

function getMemberIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["members"])) {
    return [];
  }

  return body["members"].filter((member): member is string => {
    return typeof member === "string" && member.trim() !== "";
  });
}

function getChat(body: unknown): ChatBody | null {
  if (
    !isRecord(body) ||
    typeof body["from"] !== "string" ||
    body["from"].trim() === "" ||
    typeof body["message"] !== "string"
  ) {
    return null;
  }

  return {
    from: body["from"],
    message: body["message"],
  };
}

function getErrorMessage(body: unknown): string {
  if (isRecord(body) && typeof body["message"] === "string") {
    return body["message"];
  }

  return "unknown error";
}

class PacketCodec {
  public static encode(type: string, body: unknown): Buffer {
    const bodyText = JSON.stringify(body ?? {});
    const bodyBuffer = Buffer.from(bodyText, "utf8");
    const headerText = [
      `Type: ${type}`,
      "Content-Type: application/json",
      `Content-Length: ${bodyBuffer.byteLength}`,
      "",
      "",
    ].join("\r\n");

    return Buffer.concat([Buffer.from(headerText, "utf8"), bodyBuffer]);
  }

  public static parseHeaders(headerText: string): Headers {
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

  public static decode(headers: Headers, bodyText: string): Packet | null {
    const type = headers["type"];
    if (type === undefined || type.trim() === "") {
      return null;
    }

    try {
      const body = bodyText.length === 0 ? {} : JSON.parse(bodyText);
      return { type, headers, body };
    } catch {
      return null;
    }
  }
}

class PacketReader {
  private static readonly HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");

  private _buffer = Buffer.alloc(0);
  private readonly _onPacket: (packet: Packet) => void;

  public constructor(onPacket: (packet: Packet) => void) {
    this._onPacket = onPacket;
  }

  public push(data: Buffer): void {
    this._buffer = Buffer.concat([this._buffer, data]);

    while (true) {
      const headerEndIndex = this._buffer.indexOf(PacketReader.HEADER_SEPARATOR);
      if (headerEndIndex === -1) {
        return;
      }

      const headerText = this._buffer.subarray(0, headerEndIndex).toString("utf8");
      const headers = PacketCodec.parseHeaders(headerText);
      const contentLength = Number(headers["content-length"] ?? "0");

      if (!Number.isInteger(contentLength) || contentLength < 0) {
        this._buffer = Buffer.alloc(0);
        return;
      }

      const bodyStartIndex = headerEndIndex + PacketReader.HEADER_SEPARATOR.byteLength;
      const packetEndIndex = bodyStartIndex + contentLength;
      if (this._buffer.byteLength < packetEndIndex) {
        return;
      }

      const bodyText = this._buffer.subarray(bodyStartIndex, packetEndIndex).toString("utf8");
      this._buffer = this._buffer.subarray(packetEndIndex);

      const packet = PacketCodec.decode(headers, bodyText);
      if (packet !== null) {
        this._onPacket(packet);
      }
    }
  }
}

class TcpPeerConnection {
  private readonly _socket: net.Socket;
  private readonly _packetHandlers: Array<(packet: Packet) => void> = [];
  private readonly _closeHandlers: Array<() => void> = [];
  private readonly _errorHandlers: Array<(error: Error) => void> = [];

  public constructor(socket: net.Socket) {
    this._socket = socket;
    const reader = new PacketReader((packet) => {
      for (const handler of this._packetHandlers) {
        handler(packet);
      }
    });

    this._socket.on("data", (data) => {
      reader.push(typeof data === "string" ? Buffer.from(data, "utf8") : data);
    });

    this._socket.on("close", () => {
      for (const handler of this._closeHandlers) {
        handler();
      }
    });

    this._socket.on("error", (error) => {
      for (const handler of this._errorHandlers) {
        handler(error);
      }
    });
  }

  public send(type: string, body: unknown): void {
    this._socket.write(PacketCodec.encode(type, body));
  }

  public close(): void {
    this._socket.end();
  }

  public destroy(): void {
    this._socket.destroy();
  }

  public onPacket(handler: (packet: Packet) => void): void {
    this._packetHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this._closeHandlers.push(handler);
  }

  public onError(handler: (error: Error) => void): void {
    this._errorHandlers.push(handler);
  }
}

class TcpServer {
  private readonly _host: string;
  private readonly _port: number;
  private _server: net.Server | null = null;

  public constructor(host: string, port: number) {
    this._host = host;
    this._port = port;
  }

  public listen(
    onConnection: (connection: TcpPeerConnection) => void,
    onListening: (() => void) | null = null,
  ): void {
    this._server = net.createServer((socket) => {
      onConnection(new TcpPeerConnection(socket));
    });

    this._server.on("error", (error) => {
      console.error("tcp server error:", error.message);
    });

    this._server.listen(this._port, this._host, () => {
      if (onListening !== null) {
        onListening();
      }
    });
  }

  public close(): void {
    if (this._server !== null) {
      this._server.close();
      this._server = null;
    }
  }
}

class OnlineUserDirectory {
  private readonly _users = new Map<string, OnlineUser>();

  public add(user: OnlineUser): boolean {
    if (this._users.has(user.id)) {
      return false;
    }

    this._users.set(user.id, user);
    return true;
  }

  public upsert(user: OnlineUser): void {
    this._users.set(user.id, user);
  }

  public remove(id: string): OnlineUser | null {
    const user = this._users.get(id) ?? null;
    this._users.delete(id);
    return user;
  }

  public get(id: string): OnlineUser | null {
    return this._users.get(id) ?? null;
  }

  public list(): OnlineUser[] {
    return [...this._users.values()];
  }

  public has(id: string): boolean {
    return this._users.has(id);
  }

  public clear(): void {
    this._users.clear();
  }
}

class PeerRegistry {
  private readonly _peers = new Map<string, TcpPeerConnection>();

  public register(userId: string, connection: TcpPeerConnection): void {
    const existing = this._peers.get(userId);
    if (existing !== undefined && existing !== connection) {
      existing.close();
    }

    this._peers.set(userId, connection);
  }

  public remove(userId: string): void {
    this._peers.delete(userId);
  }

  public removeIfMatches(userId: string, connection: TcpPeerConnection): boolean {
    if (this._peers.get(userId) === connection) {
      this._peers.delete(userId);
      return true;
    }

    return false;
  }

  public get(userId: string): TcpPeerConnection | null {
    return this._peers.get(userId) ?? null;
  }

  public ids(): string[] {
    return [...this._peers.keys()];
  }

  public send(userId: string, type: string, body: unknown): boolean {
    const connection = this._peers.get(userId);
    if (connection === undefined) {
      return false;
    }

    connection.send(type, body);
    return true;
  }

  public broadcast(userIds: Iterable<string>, type: string, body: unknown): void {
    for (const userId of userIds) {
      this.send(userId, type, body);
    }
  }

  public closeAll(): void {
    for (const connection of this._peers.values()) {
      connection.close();
    }

    this._peers.clear();
  }
}

class Session {
  private readonly _members = new Set<string>();

  public addMember(userId: string): void {
    this._members.add(userId);
  }

  public removeMember(userId: string): void {
    this._members.delete(userId);
  }

  public hasMember(userId: string): boolean {
    return this._members.has(userId);
  }

  public members(): string[] {
    return [...this._members.values()];
  }

  public clear(): void {
    this._members.clear();
  }

  public isEmpty(): boolean {
    return this._members.size === 0;
  }
}

class SessionManager {
  private readonly _myId: string;
  private readonly _session: Session;
  private readonly _peers: PeerRegistry;
  private readonly _pendingIncomingInvites = new Map<string, string[]>();

  public constructor(myId: string, session: Session, peers: PeerRegistry) {
    this._myId = myId;
    this._session = session;
    this._peers = peers;
  }

  public invite(userId: string): boolean {
    if (userId === this._myId) {
      return false;
    }

    if (this._peers.get(userId) === null) {
      return false;
    }

    return this._peers.send(userId, "INVITE", {
      from: this._myId,
      members: this._session.members(),
    });
  }

  public receiveInvite(from: string, members: string[]): boolean {
    if (from === this._myId || this._peers.get(from) === null) {
      return false;
    }

    this._pendingIncomingInvites.set(
      from,
      members.filter((member) => {
        return member !== this._myId && member !== from;
      }),
    );
    return true;
  }

  public acceptInvite(from: string): boolean {
    const members = this._pendingIncomingInvites.get(from);
    if (members === undefined) {
      return false;
    }

    this._pendingIncomingInvites.delete(from);
    if (!this._session.isEmpty()) {
      this.leave();
    }

    this._session.addMember(from);
    for (const member of members) {
      if (member !== this._myId && member !== from) {
        this._session.addMember(member);
      }
    }

    return this._peers.send(from, "INVITE_ACCEPT", { from: this._myId });
  }

  public rejectInvite(from: string): boolean {
    if (!this._pendingIncomingInvites.has(from)) {
      return false;
    }

    this._pendingIncomingInvites.delete(from);
    this._peers.send(from, "INVITE_REJECT", { from: this._myId });
    return true;
  }

  public handleInviteAccepted(from: string): void {
    const existingMembers = this._session.members().filter((member) => member !== from);
    this._session.addMember(from);
    this._peers.broadcast(existingMembers, "SESSION_MEMBER_JOINED", { from });
  }

  public handleMemberJoined(from: string): void {
    if (from !== this._myId) {
      this._session.addMember(from);
    }
  }

  public handleInviteRejected(from: string): void {
    this._session.removeMember(from);
  }

  public sendMessage(message: string): boolean {
    if (this._session.isEmpty()) {
      return false;
    }

    this._peers.broadcast(this._session.members(), "SESSION_CHAT", {
      from: this._myId,
      message,
    });
    return true;
  }

  public leave(): void {
    const members = this._session.members();
    this._peers.broadcast(members, "SESSION_LEAVE", { from: this._myId });
    this._session.clear();
  }

  public removeMember(userId: string): void {
    this._session.removeMember(userId);
  }

  public members(): string[] {
    return this._session.members();
  }

  public pendingInvites(): string[] {
    return [...this._pendingIncomingInvites.keys()];
  }
}

class LoginServerApp {
  private readonly _directory = new OnlineUserDirectory();
  private readonly _connections = new Map<TcpPeerConnection, OnlineUser>();
  private readonly _server: TcpServer;
  private readonly _onlineUsersFilePath: string;

  public constructor(port: number, onlineUsersFilePath: string) {
    this._server = new TcpServer("0.0.0.0", port);
    this._onlineUsersFilePath = onlineUsersFilePath;
  }

  public start(): void {
    this._directory.clear();
    this._saveOnlineUsers();

    this._server.listen(
      (connection) => {
        this._handleConnection(connection);
      },
      () => {
        console.log("login server listening on port 8000");
        console.log(`online users file: ${this._onlineUsersFilePath}`);
      },
    );
  }

  public stop(): void {
    this._server.close();
    for (const connection of this._connections.keys()) {
      connection.close();
    }
    this._connections.clear();
    this._directory.clear();
    this._saveOnlineUsers();
  }

  private _handleConnection(connection: TcpPeerConnection): void {
    connection.onPacket((packet) => {
      this._handlePacket(connection, packet);
    });

    connection.onClose(() => {
      this._removeConnection(connection);
    });

    connection.onError((error) => {
      console.error("login server socket error:", error.message);
    });
  }

  private _handlePacket(connection: TcpPeerConnection, packet: Packet): void {
    if (packet.type === "LOGIN") {
      this._handleLogin(connection, packet.body);
      return;
    }

    if (packet.type === "PONG") {
      return;
    }

    connection.send("ERROR", { message: `unsupported login packet: ${packet.type}` });
  }

  private _handleLogin(connection: TcpPeerConnection, body: unknown): void {
    if (!isOnlineUser(body)) {
      connection.send("ERROR", { message: "LOGIN body must be { id, ip, port }" });
      connection.close();
      return;
    }

    if (this._directory.has(body.id)) {
      connection.send("ERROR", { message: `duplicated id: ${body.id}` });
      connection.close();
      return;
    }

    const currentUsers = this._directory.list();
    this._directory.add(body);
    this._connections.set(connection, body);
    this._saveOnlineUsers();

    connection.send("ONLINE_USERS", { users: currentUsers });
    this._broadcast("USER_JOINED", { user: body }, connection);
    console.log(`login: ${body.id} ${body.ip}:${body.port}`);
  }

  private _removeConnection(connection: TcpPeerConnection): void {
    const user = this._connections.get(connection);
    if (user === undefined) {
      return;
    }

    this._connections.delete(connection);
    this._directory.remove(user.id);
    this._saveOnlineUsers();
    this._broadcast("USER_LEFT", { user }, connection);
    console.log(`logout: ${user.id}`);
  }

  private _broadcast(type: string, body: unknown, except: TcpPeerConnection | null = null): void {
    for (const connection of this._connections.keys()) {
      if (connection === except) {
        continue;
      }

      connection.send(type, body);
    }
  }

  private _saveOnlineUsers(): void {
    fs.writeFileSync(
      this._onlineUsersFilePath,
      `${JSON.stringify(this._directory.list(), null, 2)}\n`,
      "utf8",
    );
  }
}

class LoginClient {
  private readonly _loginServerHost: string;
  private readonly _loginServerPort: number;
  private readonly _me: OnlineUser;
  private _connection: TcpPeerConnection | null = null;
  private readonly _onlineUsersHandlers: Array<(users: OnlineUser[]) => void> = [];
  private readonly _userJoinedHandlers: Array<(user: OnlineUser) => void> = [];
  private readonly _userLeftHandlers: Array<(user: OnlineUser) => void> = [];
  private readonly _errorMessageHandlers: Array<(message: string) => void> = [];

  public constructor(loginServerHost: string, loginServerPort: number, me: OnlineUser) {
    this._loginServerHost = loginServerHost;
    this._loginServerPort = loginServerPort;
    this._me = me;
  }

  public connect(): void {
    const socket = net.createConnection(
      { host: this._loginServerHost, port: this._loginServerPort },
      () => {
        this._connection?.send("LOGIN", this._me);
      },
    );

    const connection = new TcpPeerConnection(socket);
    this._connection = connection;

    connection.onPacket((packet) => {
      this._handlePacket(packet);
    });

    connection.onClose(() => {
      console.log("login server connection closed");
    });

    connection.onError((error) => {
      console.error("login server socket error:", error.message);
    });
  }

  public close(): void {
    this._connection?.close();
    this._connection = null;
  }

  public onOnlineUsers(handler: (users: OnlineUser[]) => void): void {
    this._onlineUsersHandlers.push(handler);
  }

  public onUserJoined(handler: (user: OnlineUser) => void): void {
    this._userJoinedHandlers.push(handler);
  }

  public onUserLeft(handler: (user: OnlineUser) => void): void {
    this._userLeftHandlers.push(handler);
  }

  public onErrorMessage(handler: (message: string) => void): void {
    this._errorMessageHandlers.push(handler);
  }

  private _handlePacket(packet: Packet): void {
    if (packet.type === "ONLINE_USERS") {
      const users = getOnlineUsers(packet.body);
      if (users === null) {
        this._emitErrorMessage("invalid ONLINE_USERS body");
        return;
      }

      for (const handler of this._onlineUsersHandlers) {
        handler(users);
      }
      return;
    }

    if (packet.type === "USER_JOINED") {
      const user = getUser(packet.body);
      if (user === null) {
        this._emitErrorMessage("invalid USER_JOINED body");
        return;
      }

      for (const handler of this._userJoinedHandlers) {
        handler(user);
      }
      return;
    }

    if (packet.type === "USER_LEFT") {
      const user = getUser(packet.body);
      if (user === null) {
        this._emitErrorMessage("invalid USER_LEFT body");
        return;
      }

      for (const handler of this._userLeftHandlers) {
        handler(user);
      }
      return;
    }

    if (packet.type === "ERROR") {
      this._emitErrorMessage(getErrorMessage(packet.body));
      return;
    }

    this._emitErrorMessage(`unsupported login server packet: ${packet.type}`);
  }

  private _emitErrorMessage(message: string): void {
    for (const handler of this._errorMessageHandlers) {
      handler(message);
    }
  }
}

class PeerProtocolHandler {
  private readonly _me: OnlineUser;
  private readonly _peers: PeerRegistry;
  private readonly _sessionManager: SessionManager;

  public constructor(me: OnlineUser, peers: PeerRegistry, sessionManager: SessionManager) {
    this._me = me;
    this._peers = peers;
    this._sessionManager = sessionManager;
  }

  public attach(
    connection: TcpPeerConnection,
    initialPeerId: string | null,
    onPeerReady: (peerId: string) => void,
  ): void {
    let peerId = initialPeerId;

    if (peerId !== null) {
      this._peers.register(peerId, connection);
    }

    connection.onPacket((packet) => {
      if (packet.type === "PEER_HELLO") {
        peerId = this._handlePeerHello(connection, packet.body);
        if (peerId !== null) {
          onPeerReady(peerId);
        }
        return;
      }

      if (packet.type === "PEER_HELLO_ACK") {
        peerId = this._handlePeerHelloAck(connection, packet.body);
        if (peerId !== null) {
          onPeerReady(peerId);
        }
        return;
      }

      if (packet.type === "CHAT") {
        this._handleChat(packet.body);
        return;
      }

      if (packet.type === "INVITE") {
        this._handleInvite(packet.body);
        return;
      }

      if (packet.type === "INVITE_ACCEPT") {
        this._handleInviteAccepted(packet.body);
        return;
      }

      if (packet.type === "INVITE_REJECT") {
        this._handleInviteRejected(packet.body);
        return;
      }

      if (packet.type === "SESSION_CHAT") {
        this._handleSessionChat(packet.body);
        return;
      }

      if (packet.type === "SESSION_LEAVE") {
        this._handleSessionLeave(packet.body);
        return;
      }

      if (packet.type === "SESSION_MEMBER_JOINED") {
        this._handleSessionMemberJoined(packet.body);
        return;
      }

      if (packet.type === "ERROR") {
        console.error("peer error:", getErrorMessage(packet.body));
        return;
      }

      console.log(`unsupported peer packet: ${packet.type}`);
    });

    connection.onClose(() => {
      if (peerId !== null) {
        const removed = this._peers.removeIfMatches(peerId, connection);
        if (removed) {
          this._sessionManager.removeMember(peerId);
          console.log(`peer disconnected: ${peerId}`);
        }
      }
    });

    connection.onError((error) => {
      console.error("peer socket error:", error.message);
    });
  }

  private _handlePeerHello(connection: TcpPeerConnection, body: unknown): string | null {
    const user = getUser(body);
    if (user === null) {
      connection.send("ERROR", { message: "invalid PEER_HELLO body" });
      return null;
    }

    this._peers.register(user.id, connection);
    connection.send("PEER_HELLO_ACK", { user: this._me });
    console.log(`peer connected: ${user.id}`);
    return user.id;
  }

  private _handlePeerHelloAck(connection: TcpPeerConnection, body: unknown): string | null {
    const user = getUser(body);
    if (user === null) {
      connection.send("ERROR", { message: "invalid PEER_HELLO_ACK body" });
      return null;
    }

    this._peers.register(user.id, connection);
    return user.id;
  }

  private _handleChat(body: unknown): void {
    const chat = getChat(body);
    if (chat === null) {
      console.error("invalid CHAT body");
      return;
    }

    console.log(`[direct:${chat.from}] ${chat.message}`);
  }

  private _handleInvite(body: unknown): void {
    const from = getFrom(body);
    if (from === null) {
      console.error("invalid INVITE body");
      return;
    }

    const received = this._sessionManager.receiveInvite(from, getMemberIds(body));
    if (!received) {
      console.log(`ignored session invite from ${from}`);
      return;
    }

    console.log(`session invite from ${from}. use /accept ${from} or /reject ${from}`);
  }

  private _handleInviteAccepted(body: unknown): void {
    const from = getFrom(body);
    if (from === null) {
      console.error("invalid INVITE_ACCEPT body");
      return;
    }

    this._sessionManager.handleInviteAccepted(from);
    console.log(`${from} joined the session`);
  }

  private _handleInviteRejected(body: unknown): void {
    const from = getFrom(body);
    if (from === null) {
      console.error("invalid INVITE_REJECT body");
      return;
    }

    this._sessionManager.handleInviteRejected(from);
    console.log(`${from} rejected the session invite`);
  }

  private _handleSessionChat(body: unknown): void {
    const chat = getChat(body);
    if (chat === null) {
      console.error("invalid SESSION_CHAT body");
      return;
    }

    console.log(`[session:${chat.from}] ${chat.message}`);
  }

  private _handleSessionLeave(body: unknown): void {
    const from = getFrom(body);
    if (from === null) {
      console.error("invalid SESSION_LEAVE body");
      return;
    }

    this._sessionManager.removeMember(from);
    console.log(`${from} left the session`);
  }

  private _handleSessionMemberJoined(body: unknown): void {
    const from = getFrom(body);
    if (from === null) {
      console.error("invalid SESSION_MEMBER_JOINED body");
      return;
    }

    this._sessionManager.handleMemberJoined(from);
    console.log(`${from} joined the session`);
  }
}

class UserNode {
  private readonly _me: OnlineUser;
  private readonly _onlineUsers = new OnlineUserDirectory();
  private readonly _peerServer: TcpServer;
  private readonly _loginClient: LoginClient;
  private readonly _peers = new PeerRegistry();
  private readonly _session = new Session();
  private readonly _sessionManager: SessionManager;
  private readonly _peerProtocolHandler: PeerProtocolHandler;
  private readonly _pendingInvites = new Set<string>();

  public constructor(loginServerPort: number, me: OnlineUser) {
    this._me = me;
    this._peerServer = new TcpServer("0.0.0.0", me.port);
    this._loginClient = new LoginClient("127.0.0.1", loginServerPort, me);
    this._sessionManager = new SessionManager(me.id, this._session, this._peers);
    this._peerProtocolHandler = new PeerProtocolHandler(me, this._peers, this._sessionManager);
  }

  public start(): void {
    this._peerServer.listen(
      (connection) => {
        this._peerProtocolHandler.attach(connection, null, (peerId) => {
          this._flushPendingInvite(peerId);
        });
      },
      () => {
        console.log(`peer server listening on ${this._me.ip}:${this._me.port}`);
        this._setupLoginClient();
        this._loginClient.connect();
      },
    );
  }

  public stop(): void {
    this._sessionManager.leave();
    this._loginClient.close();
    this._peerServer.close();
    this._peers.closeAll();
  }

  public listOnlineUsers(): OnlineUser[] {
    return this._onlineUsers.list();
  }

  public listPeers(): string[] {
    return this._peers.ids();
  }

  public listSessionMembers(): string[] {
    return this._sessionManager.members();
  }

  public listPendingInvites(): string[] {
    return this._sessionManager.pendingInvites();
  }

  public invite(userId: string): boolean {
    if (this._peers.get(userId) === null) {
      const user = this._onlineUsers.get(userId);
      if (user === null) {
        return false;
      }

      this._pendingInvites.add(userId);
      this._connectPeer(user);
      console.log(`connecting to peer before invite: ${userId}`);
      return true;
    }

    return this._sessionManager.invite(userId);
  }

  public sendSessionMessage(message: string): boolean {
    return this._sessionManager.sendMessage(message);
  }

  public acceptInvite(userId: string): boolean {
    return this._sessionManager.acceptInvite(userId);
  }

  public rejectInvite(userId: string): boolean {
    return this._sessionManager.rejectInvite(userId);
  }

  public leaveSession(): void {
    this._sessionManager.leave();
  }

  public sendDirectMessage(userId: string, message: string): boolean {
    return this._peers.send(userId, "CHAT", {
      from: this._me.id,
      message,
    });
  }

  private _setupLoginClient(): void {
    this._loginClient.onOnlineUsers((users) => {
      this._onlineUsers.clear();
      console.log("online users:");

      for (const user of users) {
        if (user.id === this._me.id) {
          continue;
        }

        this._onlineUsers.add(user);
        console.log(`- ${user.id} ${user.ip}:${user.port}`);
        this._connectPeer(user);
      }

      if (users.length === 0) {
        console.log("(none)");
      }
    });

    this._loginClient.onUserJoined((user) => {
      if (user.id === this._me.id) {
        return;
      }

      this._onlineUsers.upsert(user);
      console.log(`user joined: ${user.id} ${user.ip}:${user.port}`);
    });

    this._loginClient.onUserLeft((user) => {
      this._onlineUsers.remove(user.id);
      const peer = this._peers.get(user.id);
      if (peer !== null) {
        peer.close();
      }
      this._peers.remove(user.id);
      this._sessionManager.removeMember(user.id);
      console.log(`user left: ${user.id}`);
    });

    this._loginClient.onErrorMessage((message) => {
      console.error("login server error:", message);
    });
  }

  private _connectPeer(user: OnlineUser): void {
    if (user.id === this._me.id || this._peers.get(user.id) !== null) {
      return;
    }

    const socket = net.createConnection({ host: user.ip, port: user.port }, () => {
      connection.send("PEER_HELLO", { user: this._me });
      console.log(`connected to peer: ${user.id}`);
    });

    const connection = new TcpPeerConnection(socket);
    this._peerProtocolHandler.attach(connection, user.id, (peerId) => {
      this._flushPendingInvite(peerId);
    });
  }

  private _flushPendingInvite(peerId: string): void {
    if (!this._pendingInvites.has(peerId)) {
      return;
    }

    this._pendingInvites.delete(peerId);
    const invited = this._sessionManager.invite(peerId);
    if (invited) {
      console.log(`invited: ${peerId}`);
      return;
    }

    console.log(`cannot invite after peer connection: ${peerId}`);
  }
}

class CommandLoop {
  private readonly _rl: Interface;
  private readonly _node: UserNode;

  public constructor(rl: Interface, node: UserNode) {
    this._rl = rl;
    this._node = node;
  }

  public async run(): Promise<void> {
    this._printHelp();

    while (true) {
      const line = await this._rl.question("> ");
      const trimmedLine = line.trim();

      if (trimmedLine === "") {
        continue;
      }

      if (trimmedLine === "/quit") {
        this._node.stop();
        this._rl.close();
        return;
      }

      if (trimmedLine === "/users") {
        this._printUsers();
        continue;
      }

      if (trimmedLine === "/peers") {
        console.log("peers:", this._node.listPeers());
        continue;
      }

      if (trimmedLine === "/members") {
        console.log("session members:", this._node.listSessionMembers());
        continue;
      }

      if (trimmedLine === "/invites") {
        console.log("pending invites:", this._node.listPendingInvites());
        continue;
      }

      if (trimmedLine === "/leave") {
        this._node.leaveSession();
        console.log("left session");
        continue;
      }

      if (trimmedLine.startsWith("/invite ")) {
        this._handleInvite(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith("/accept ")) {
        this._handleAccept(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith("/reject ")) {
        this._handleReject(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith("/send ")) {
        this._handleSessionMessage(trimmedLine);
        continue;
      }

      if (trimmedLine.startsWith("@")) {
        this._handleDirectMessage(trimmedLine);
        continue;
      }

      console.log("unknown command");
      this._printHelp();
    }
  }

  private _printHelp(): void {
    console.log(
      "commands: /users, /peers, /invite userId, /invites, /accept userId, /reject userId, /members, /send message, /leave, /quit",
    );
    console.log("direct message: @userId message");
  }

  private _printUsers(): void {
    const users = this._node.listOnlineUsers();
    if (users.length === 0) {
      console.log("online users: (none)");
      return;
    }

    console.log("online users:");
    for (const user of users) {
      console.log(`- ${user.id} ${user.ip}:${user.port}`);
    }
  }

  private _handleInvite(line: string): void {
    const userId = line.slice("/invite ".length).trim();
    if (userId === "") {
      console.log("use: /invite userId");
      return;
    }

    const invited = this._node.invite(userId);
    if (!invited) {
      console.log(`cannot invite: ${userId}`);
      return;
    }

    console.log(`invite requested: ${userId}`);
  }

  private _handleAccept(line: string): void {
    const userId = line.slice("/accept ".length).trim();
    if (userId === "") {
      console.log("use: /accept userId");
      return;
    }

    const accepted = this._node.acceptInvite(userId);
    if (!accepted) {
      console.log(`no pending invite from: ${userId}`);
      return;
    }

    console.log(`accepted invite from: ${userId}`);
  }

  private _handleReject(line: string): void {
    const userId = line.slice("/reject ".length).trim();
    if (userId === "") {
      console.log("use: /reject userId");
      return;
    }

    const rejected = this._node.rejectInvite(userId);
    if (!rejected) {
      console.log(`no pending invite from: ${userId}`);
      return;
    }

    console.log(`rejected invite from: ${userId}`);
  }

  private _handleSessionMessage(line: string): void {
    const message = line.slice("/send ".length).trim();
    if (message === "") {
      console.log("use: /send message");
      return;
    }

    const sent = this._node.sendSessionMessage(message);
    if (!sent) {
      console.log("session is empty");
    }
  }

  private _handleDirectMessage(line: string): void {
    const firstSpaceIndex = line.indexOf(" ");
    if (firstSpaceIndex === -1) {
      console.log("use: @userId message");
      return;
    }

    const userId = line.slice(1, firstSpaceIndex).trim();
    const message = line.slice(firstSpaceIndex + 1).trim();
    if (userId === "" || message === "") {
      console.log("use: @userId message");
      return;
    }

    const sent = this._node.sendDirectMessage(userId, message);
    if (!sent) {
      console.log(`peer not connected: ${userId}`);
    }
  }
}

async function readClientInput(rl: Interface): Promise<OnlineUser | null> {
  const id = (await rl.question("Enter your login ID: ")).trim();
  const ipInput = (await rl.question("Enter your peer IP [127.0.0.1]: ")).trim();
  const portInput = (await rl.question("Enter your peer port: ")).trim();
  const ip = ipInput === "" ? "127.0.0.1" : ipInput;
  const port = Number(portInput);

  if (id === "" || ip === "" || !Number.isInteger(port) || port <= 0) {
    console.log("invalid client input");
    return null;
  }

  return { id, ip, port };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const loginServerPort = 8000;

  if (mode === "s") {
    const onlineUsersFilePath = path.join(process.cwd(), "online_users.json");
    const server = new LoginServerApp(loginServerPort, onlineUsersFilePath);
    server.start();
    return;
  }

  if (mode === "c") {
    const rl = readline.createInterface({ input, output });
    const me = await readClientInput(rl);
    if (me === null) {
      rl.close();
      return;
    }

    const node = new UserNode(loginServerPort, me);
    node.start();

    const commandLoop = new CommandLoop(rl, node);
    await commandLoop.run();
    return;
  }

  console.log("usage: npm start s");
  console.log("usage: npm start c");
}

await main();
