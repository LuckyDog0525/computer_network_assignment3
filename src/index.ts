import net from "node:net";
import readline from "node:readline";

class Server {
  private _server: net.Server;

  private _clients: net.Socket[];

  private _hartbeatTimer: NodeJS.Timeout | null;

  private static HARTBEAT_INTERVAL = 6000;

  public constructor() {
    this._server = net.createServer(this._handleConnection.bind(this));

    this._server.on("error", (err) => {
      console.error("server error:", err);
    });

    this._clients = [];

    this._hartbeatTimer = null;
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

    if (this._hartbeatTimer !== null) {
      this._hartbeatTimer = setInterval(this._checkClientsAlive.bind(this), Server.HARTBEAT_INTERVAL);
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
      if (this._hartbeatTimer !== null) {
        clearInterval(this._hartbeatTimer);
        this._hartbeatTimer = null;
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
  private _username: string;

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
