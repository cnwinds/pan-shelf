import { EventEmitter } from 'node:events';

// 进程内事件总线：任务进度、日志、状态变化都从这里推给 SSE
export const bus = new EventEmitter();
bus.setMaxListeners(100);
