// STAND-INS, not Colyseus. The recipe in cases/colyseus/room.ts is type-checked and run against these small structural shapes of Colyseus 0.16's
// `Room` and `Client`, because init does not generate it and the test must not need the real (large, fast-moving) dependency. In your project import
// the real types, `import type { Client, Room } from 'colyseus'`, and delete this file's use: the members named here are the only ones the recipe touches.

/** A connected player, as Colyseus 0.16 hands one to the room's methods. */
export interface Client {
  /** The id Colyseus gives this connection. */
  sessionId: string;
  /** Send a message of a type to this client. */
  send(type: string, message?: unknown): void;
  /** Close this client's connection with a code and a reason. */
  leave(code?: number, reason?: string): void;
}

/** A room, as Colyseus 0.16's `Room` class: the members the recipe uses. */
export interface Room {
  roomId: string;
  /** Registers a handler for one message type sent by clients. */
  onMessage(type: string, callback: (client: Client, message: unknown) => void): void;
  /** Called after `onAuth` accepted a client; `auth` is what `onAuth` returned. */
  onJoin?(client: Client, options?: unknown, auth?: unknown): void | Promise<void>;
  /** Called when a client has left. */
  onLeave?(client: Client, consented?: boolean): void | Promise<void>;
}
