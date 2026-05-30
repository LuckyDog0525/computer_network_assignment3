# Architecture Plan: Layered Class Design

## 1. Goal

`network_design.pdf`의 `Example Structure1`을 따르는 멀티 유저 메신저를 구현한다.

선택한 class 추상화는 다음과 같은 계층형 구조다.

```text
Transport Layer
  - TCP 연결, packet framing, packet 송수신

Application Layer
  - login protocol, peer protocol, user node 실행 흐름

Domain Layer
  - online user 목록, peer 목록, messenger session 상태
```

실제 코드는 `src/index.ts` 하나에 작성하되, class와 책임은 계층별로 분리한다.

## 2. Target Runtime Architecture

`Example Structure1`의 실행 구조:

```text
                     +----------------+
                     |  Login Server  |
                     |----------------|
                     | online users   |
                     | id / ip / port |
                     +----------------+
                       ^      ^      ^
                       |      |      |
                    LOGIN  LOGIN  LOGIN
                       |      |      |

        +--------------+      |      +--------------+
        |                     |                     |
        v                     v                     v
+---------------+     +---------------+     +---------------+
| User Program  |<--->| User Program  |<--->| User Program  |
| alice         |     | bob           |     | chris         |
| peer server   |<--->| peer server   |<--->| peer server   |
+---------------+     +---------------+     +---------------+
```

핵심 규칙:

- login server는 online user directory 역할만 한다.
- 채팅, 초대, 세션 메시지는 login server를 거치지 않는다.
- 각 user program은 peer server와 peer client 역할을 동시에 가진다.
- 모든 network message는 HTTP-like packet format을 사용한다.

## 3. Layer Overview

### 3.1 Transport Layer

TCP와 packet 처리만 담당한다.

이 계층은 packet의 의미를 알지 않는다.

담당:

- TCP server listen
- TCP client connect
- socket close/error 처리
- stream data를 packet으로 변환
- packet을 string으로 encode해서 socket에 write

Class:

```text
PacketCodec
PacketReader
TcpPeerConnection
TcpServer
```

### 3.2 Application Layer

프로토콜 흐름을 담당한다.

담당:

- login server packet 처리
- user program의 login flow
- peer protocol 처리
- command UI와 domain object 연결
- `Example Structure1`의 전체 실행 흐름 조립

Class:

```text
LoginServerApp
LoginClient
PeerProtocolHandler
UserNode
CommandLoop
```

### 3.3 Domain Layer

메신저의 상태와 규칙을 담당한다.

이 계층은 socket을 직접 다루지 않는다.

담당:

- online user 목록 관리
- peer 목록 관리
- session member 관리
- invite/send/leave의 상태 변경 규칙

Class:

```text
OnlineUserDirectory
PeerRegistry
Session
SessionManager
```

## 4. Core Types

```ts
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
```

주요 packet body:

```ts
type OnlineUsersBody = {
  users: OnlineUser[];
};

type UserEventBody = {
  user: OnlineUser;
};

type PeerHelloBody = {
  user: OnlineUser;
};

type ChatBody = {
  from: string;
  message: string;
};

type InviteBody = {
  from: string;
};

type SessionLeaveBody = {
  from: string;
};
```

## 5. Transport Layer Design

### 5.1 PacketCodec

책임:

- `Packet`을 HTTP-like text format으로 encode
- raw header/body text를 `Packet`으로 decode
- `Content-Length` 계산
- JSON body parse/stringify

Message format:

```text
Type: SESSION_CHAT
Content-Type: application/json
Content-Length: 42

{"from":"alice","message":"hello everyone"}
```

Interface:

```ts
class PacketCodec {
  static encode(type: string, body: unknown): string;
  static parseHeaders(headerText: string): Headers;
  static decode(type: string, headers: Headers, bodyText: string): Packet | null;
}
```

### 5.2 PacketReader

책임:

- TCP stream chunk를 누적 buffer에 저장
- `\r\n\r\n`로 header boundary 탐지
- `Content-Length`만큼 body가 도착할 때까지 대기
- 완성된 packet을 callback으로 전달

Interface:

```ts
class PacketReader {
  constructor(onPacket: (packet: Packet) => void);
  push(data: string): void;
}
```

### 5.3 TcpPeerConnection

책임:

- 하나의 `net.Socket`을 packet 단위 연결로 감싼다.
- `send(type, body)` API 제공
- packet, close, error 이벤트 callback 제공

Interface:

```ts
class TcpPeerConnection {
  constructor(socket: net.Socket);

  send(type: string, body: unknown): void;
  close(): void;

  onPacket(handler: (packet: Packet) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}
```

주의:

- 이 class는 peer user의 id를 알 필요가 없다.
- 어떤 packet이 login packet인지 peer packet인지 판단하지 않는다.

### 5.4 TcpServer

책임:

- 지정 port에서 TCP listen
- 새 socket을 `TcpPeerConnection`으로 감싸서 application layer에 전달

Interface:

```ts
class TcpServer {
  constructor(host: string, port: number);
  listen(onConnection: (connection: TcpPeerConnection) => void): void;
  close(): void;
}
```

## 6. Domain Layer Design

### 6.1 OnlineUserDirectory

책임:

- online user 목록 관리
- user id 중복 검사
- JSON 파일 저장용 list 제공

Interface:

```ts
class OnlineUserDirectory {
  add(user: OnlineUser): boolean;
  remove(id: string): OnlineUser | null;
  get(id: string): OnlineUser | null;
  list(): OnlineUser[];
  has(id: string): boolean;
  clear(): void;
}
```

사용 위치:

- `LoginServerApp`: 실제 online user registry
- `UserNode`: login server에서 받은 online user cache

### 6.2 PeerRegistry

책임:

- user id와 peer connection 매핑
- peer send/broadcast 제공
- peer disconnect 시 제거

Interface:

```ts
class PeerRegistry {
  register(userId: string, connection: TcpPeerConnection): void;
  remove(userId: string): void;
  get(userId: string): TcpPeerConnection | null;
  ids(): string[];
  send(userId: string, type: string, body: unknown): boolean;
  broadcast(userIds: Iterable<string>, type: string, body: unknown): void;
}
```

### 6.3 Session

책임:

- 현재 messenger session member 상태 관리
- member 추가/삭제/전체 조회

Interface:

```ts
class Session {
  addMember(userId: string): void;
  removeMember(userId: string): void;
  hasMember(userId: string): boolean;
  members(): string[];
  clear(): void;
  isEmpty(): boolean;
}
```

### 6.4 SessionManager

책임:

- session 상태 변경 규칙
- invite/send/leave 로직
- peer packet 송신은 `PeerRegistry`에 위임

Interface:

```ts
class SessionManager {
  constructor(
    myId: string,
    session: Session,
    peers: PeerRegistry,
  );

  invite(userId: string): boolean;
  acceptInvite(from: string): void;
  handleInviteAccepted(from: string): void;
  sendMessage(message: string): boolean;
  leave(): void;
  removeMember(userId: string): void;
  members(): string[];
}
```

동작:

- `invite(userId)`
  - peer 연결 확인
  - session에 user 추가
  - `INVITE` packet 전송
- `acceptInvite(from)`
  - session에 from 추가
  - `INVITE_ACCEPT` 전송
- `sendMessage(message)`
  - session member 전체에게 `SESSION_CHAT` 전송
- `leave()`
  - session member 전체에게 `SESSION_LEAVE` 전송
  - session clear

## 7. Application Layer Design

### 7.1 LoginServerApp

책임:

- login server process의 main application
- incoming connection에서 `LOGIN` 처리
- online user directory와 connection mapping 관리
- `online_users.json` 저장
- user join/leave event broadcast

상태:

```ts
directory: OnlineUserDirectory
connections: Map<TcpPeerConnection, OnlineUser>
server: TcpServer
```

Interface:

```ts
class LoginServerApp {
  constructor(port: number, onlineUsersFilePath: string);
  start(): void;
  stop(): void;
}
```

처리 packet:

```text
LOGIN
PONG optional
```

송신 packet:

```text
ONLINE_USERS
USER_JOINED
USER_LEFT
ERROR
```

### 7.2 LoginClient

책임:

- user program에서 login server와 통신
- `LOGIN` packet 전송
- `ONLINE_USERS`, `USER_JOINED`, `USER_LEFT`, `ERROR` event를 UserNode에 전달

Interface:

```ts
class LoginClient {
  constructor(loginServerHost: string, loginServerPort: number, me: OnlineUser);

  connect(): void;
  close(): void;

  onOnlineUsers(handler: (users: OnlineUser[]) => void): void;
  onUserJoined(handler: (user: OnlineUser) => void): void;
  onUserLeft(handler: (user: OnlineUser) => void): void;
  onErrorMessage(handler: (message: string) => void): void;
}
```

### 7.3 PeerProtocolHandler

책임:

- peer connection에서 들어오는 packet을 처리
- `PEER_HELLO`로 peer id 확정
- session 관련 packet을 `SessionManager`에 위임

Interface:

```ts
class PeerProtocolHandler {
  constructor(
    me: OnlineUser,
    peers: PeerRegistry,
    sessionManager: SessionManager,
  );

  attach(connection: TcpPeerConnection, initialPeerId: string | null): void;
}
```

처리 packet:

```text
PEER_HELLO
CHAT
INVITE
INVITE_ACCEPT
SESSION_CHAT
SESSION_LEAVE
SESSION_MEMBER_JOINED
ERROR
```

### 7.4 UserNode

책임:

- user program 전체 조립
- peer server 시작
- login server 연결
- online user update에 따라 peer 연결 생성
- command loop에 필요한 API 제공

상태:

```ts
me: OnlineUser
onlineUsers: OnlineUserDirectory
peerServer: TcpServer
loginClient: LoginClient
peers: PeerRegistry
session: Session
sessionManager: SessionManager
peerProtocolHandler: PeerProtocolHandler
```

Interface:

```ts
class UserNode {
  constructor(loginServerPort: number, me: OnlineUser);

  start(): void;
  stop(): void;

  listOnlineUsers(): OnlineUser[];
  listPeers(): string[];
  listSessionMembers(): string[];

  invite(userId: string): boolean;
  sendSessionMessage(message: string): boolean;
  leaveSession(): void;
  sendDirectMessage(userId: string, message: string): boolean;
}
```

### 7.5 CommandLoop

책임:

- text UI 입력 처리
- command를 UserNode API 호출로 변환

지원 command:

```text
/users
/peers
/invite userId
/members
/send message
/leave
/quit
@userId message
```

Interface:

```ts
class CommandLoop {
  constructor(rl: Interface, node: UserNode);
  run(): Promise<void>;
}
```

## 8. Packet Types

### 8.1 Login Protocol

Login server와 user program 사이에서만 사용한다.

```text
LOGIN
ONLINE_USERS
USER_JOINED
USER_LEFT
ERROR
```

### 8.2 Peer Protocol

User program끼리 직접 사용한다.

```text
PEER_HELLO
CHAT
INVITE
INVITE_ACCEPT
SESSION_CHAT
SESSION_LEAVE
ERROR
```

## 9. Main Flows

### 9.1 Server Mode

```text
main
  -> new LoginServerApp(8000, online_users.json)
  -> start()
```

### 9.2 Client Mode

```text
main
  -> read id, ip, port
  -> new UserNode(8000, me)
  -> node.start()
  -> new CommandLoop(rl, node)
  -> commandLoop.run()
```

### 9.3 User Login Flow

```text
UserNode
  -> peerServer.listen()
  -> loginClient.connect()
  -> LOGIN { id, ip, port }
  <- ONLINE_USERS { users }
  -> onlineUsers.add(...)
  -> connect to each existing peer
```

### 9.4 New User Joined Flow

```text
LoginServerApp
  <- LOGIN from Bob
  -> directory.add(Bob)
  -> USER_JOINED { user: Bob } to existing users

Alice UserNode
  <- USER_JOINED Bob
  -> onlineUsers.add(Bob)
  -> connectPeer(Bob)
```

### 9.5 Invite Flow

```text
CommandLoop
  -> UserNode.invite("bob")
  -> SessionManager.invite("bob")
  -> PeerRegistry.send("bob", "INVITE", { from: "alice" })

Bob PeerProtocolHandler
  <- INVITE
  -> SessionManager.acceptInvite("alice")
  -> PeerRegistry.send("alice", "INVITE_ACCEPT", { from: "bob" })
```

기존 session에 여러 명이 있는 경우:

```text
Alice invites Chris
  -> INVITE body includes current members
  -> Chris adds Alice and existing members
  <- INVITE_ACCEPT from Chris
  -> Alice broadcasts SESSION_MEMBER_JOINED to existing members
```

### 9.6 Session Broadcast Flow

```text
CommandLoop
  -> UserNode.sendSessionMessage("hello")
  -> SessionManager.sendMessage("hello")
  -> PeerRegistry.broadcast(session.members(), "SESSION_CHAT", ...)
```

### 9.7 Leave Flow

```text
CommandLoop
  -> UserNode.leaveSession()
  -> SessionManager.leave()
  -> PeerRegistry.broadcast(session.members(), "SESSION_LEAVE", ...)
  -> Session.clear()
```

## 10. Dependency Direction

권장 의존성 방향:

```text
Application Layer
  depends on Transport Layer
  depends on Domain Layer

Domain Layer
  should not depend on net.Socket
  should not parse raw packet text

Transport Layer
  should not know LOGIN, INVITE, SESSION_CHAT semantics
```

실제 구현에서 `SessionManager`가 `PeerRegistry`를 사용하므로 domain과 transport가 약간 연결된다. 과제 규모에서는 허용하되, `SessionManager`는 socket을 직접 만지지 않고 `PeerRegistry.send()`만 호출하게 한다.

## 11. File Layout

이번 과제는 `src/index.ts` 하나에 구현한다.

권장 코드 순서:

```text
src/index.ts
  1. imports
  2. core types
  3. validation helpers
  4. Transport Layer
     - PacketCodec
     - PacketReader
     - TcpPeerConnection
     - TcpServer
  5. Domain Layer
     - OnlineUserDirectory
     - PeerRegistry
     - Session
     - SessionManager
  6. Application Layer
     - LoginServerApp
     - LoginClient
     - PeerProtocolHandler
     - UserNode
     - CommandLoop
  7. main()
```

## 12. Scope

구현할 것:

- login server
- user program
- online user directory
- P2P peer connection
- HTTP-like packet format
- session invite
- session broadcast message
- session leave
- text command UI

구현하지 않을 것:

- GUI
- password authentication
- encryption
- NAT traversal
- message persistence
- file transfer
- offline message
- multiple room support
- manual invite accept/reject

## 13. Manual Test Scenario

Terminal 1:

```bash
npm start s
```

Terminal 2:

```bash
npm start c
```

```text
alice
127.0.0.1
8080
```

Terminal 3:

```bash
npm start c
```

```text
bob
127.0.0.1
8081
```

Terminal 4:

```bash
npm start c
```

```text
chris
127.0.0.1
8082
```

Commands:

```text
/users
/peers
/invite bob
/invite chris
/members
/send hello everyone
/leave
/quit
```

Expected:

- `online_users.json`에 현재 online user 목록이 저장된다.
- client 시작 시 online user 목록이 출력된다.
- user program끼리 직접 TCP 연결된다.
- `/invite` 후 session member가 추가된다.
- `/send`가 session member 전체에게 전달된다.
- `/leave` 후 session member가 제거된다.
- `/quit` 후 login server online 목록에서 제거된다.
