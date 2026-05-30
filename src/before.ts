import net from "node:net";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import fs from "node:fs";


type Headers = Record<string, string>;

type Body = {
    from : string;
    message : string;
}

type Packet = {
    type: string;
    headers: Headers;
    body: Body;
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

type LoginUser{
  id: string;
  ip: string;
  port: number; 
};


class Server {
  private static readonly ONLINE_USERS_FILE = path.join(process.cwd(), "login_users.json");

  private _server: net.Server;

  private _clients: net.Socket[];

  private _heartbeatTimer: NodeJS.Timeout | null;

  private static HEARTBEAT_INTERVAL = 6000;

  public constructor() {
    this._server = net.createServer(this._handleConnection.bind(this));

    this._server.on("error", (err) => {
      console.error("server error:", err);
    });

    this._clients = [];

    this._heartbeatTimer = null;
  }

  private _handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");

    socket.write("hello from server\n");

    socket.on("data", (data) => {
      console.log("received:", data);

      // echo back
      socket.write(`echo: ${data}`);
    });

    socket.on("end", () => {
      const index = this._clients.indexOf(socket);
      if (index !== -1) {
        this._clients.splice(index, 1);
      }
      console.log("client disconnected");
    });

    socket.on("error", (err) => {
      console.error("socket error:", err.message);
    });

    this._clients.push(socket);

    if (this._heartbeatTimer !== null) {
      this._heartbeatTimer = setInterval(this._checkClientsAlive.bind(this), Server.HEARTBEAT_INTERVAL);
    }
  }

  private static HEARTBEAT_TIMEOUT = 3000;

  private async _checkClientsAlive(): Promise<void> {
    const promises: Promise<[net.Socket, boolean]>[] = [];

    const clients = [...this._clients];

    for (const client of clients) {
      const promise = new Promise<[net.Socket, boolean]>((resolve) => {
        client.write("req");

        const removeListeners = () => {
          client.off("data", handleData);
          client.off("error", handleError);
        };

        const handleData = (data: string) => {
          if (data === "res") {
            removeListeners();
            resolve([client, true]);
          }
        };
        const handleError = (/* err: Error */) => {
          removeListeners();
          resolve([client, false]);
        };

        client.on("data", handleData);
        client.on("error", handleError);

        setTimeout(() => {
          client.end();
          removeListeners();
          resolve([client, false]);
        }, Server.HEARTBEAT_TIMEOUT);
      });

      promises.push(promise);
    };
    const awaitedClients = await Promise.all(promises);

    const clientsSet = new Set(this._clients);
    for (const awaitedClient of awaitedClients) {
      const [client, isAlive] = awaitedClient;

      if (clientsSet.has(client)) {
        if (!isAlive) {
          clientsSet.delete(client);
        }
      }
    }
    this._clients = [...clientsSet];

    if (this._clients.length === 0) {
      if (this._heartbeatTimer !== null) {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
      }
    }
  }

  public listen(port: number): void {
    this._server.listen(port, "0.0.0.0", () => {
      console.log(`TCP server listening on ${port}`);
    });
  }
}

class Client {
  private _socket: net.Socket;
  private _loginID: Promise<string> | null = null;
  
  public constructor(port: number) {
    const socket = this._socket = net.createConnection(
      { host: "0.0.0.0", port: port },
      () => { console.log("connected"); }
    );

    socket.setEncoding("utf8");

    socket.on("connect", () => {
      console.log("connected to server");
    });
    
    socket.on("data", (data) => {
      if (data === "req") {
        socket.write("res");
      }

      console.log("from server:", data);
    });

    socket.on("end", () => {
      console.log("server closed connection");
    });

    socket.on("error", (err) => {
      console.error("socket error:", err.message);
    });
  }
}
// 1. list 관리 propagation
// 2. client - server 통신 <<
// 3. packet format << http 비슷하게?


function main(): void {
  const initParam = process.argv[2];

  if (initParam === undefined) {
    console.log("init param required");
  }

  const PORT = 8000;

  if (initParam === "s") {
    const server = new Server();
    server.listen(PORT);
  } else if (initParam === "c") {
    const client = new Client(PORT);
  } else {
    console.log("invalid init param");
  }
}

main();

// 1. login server <- online list user 관리

// client A, B, C

// 1. A 먼저 접속
// 2. B 접속
// 3. C 접속


// client B 입장에서 보면:

// case1 : client B 접속 -> Server 가 A 가 현재 connection list 에 있음을 response
// case2 : client C 접속 -> Server 가 추가로 접속한 사람에 대한 정보를 보내줘야함.
// -> 모든 리스트를 통째로 다시 보낸다. 또는 추가된 델타만 보낸다.

// 2. p2p chat

// 2.1. client 하나가 모든 채팅 기록 책임
// 2.2. 모든 클라이언트 평등한 구조 <- block chain 느낌 구현하면 될듯

// 3. udp holepunching <- 이런거 안하면 실제로는 쓸수 없는 프로그램.