// Simple launcher to start the service on a fixed port for local verification
import { startService } from './service.js';

const port = Number(process.env.PORT || 4317);
startService({ port });
// Keep process alive until interrupted
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
