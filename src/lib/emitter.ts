import { EventEmitter } from 'events';

// Create a globally persistent EventEmitter instance in Node.js development mode
declare global {
  var realtimeEmitter: EventEmitter | undefined;
}

if (!global.realtimeEmitter) {
  global.realtimeEmitter = new EventEmitter();
}

export const realtimeEmitter = global.realtimeEmitter;
