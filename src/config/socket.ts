import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export const setIO = (server: SocketIOServer): void => {
  io = server;
};

export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call setIO() first.');
  }
  return io;
};
