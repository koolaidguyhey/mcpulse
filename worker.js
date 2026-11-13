import { handleWorkerRequest } from './backend/src/server.js';
import { initializeConfig } from './backend/src/config.js';
import { runMaintenance } from './backend/src/database.js';

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleWorkerRequest(request, env);
    } catch (error) {
      console.error('MC Pulse Worker initialization/request failure:', error?.message || error);
      return new Response(JSON.stringify({ error: { code: 'CONFIGURATION_ERROR', message: 'MC Pulse API is not configured correctly. Check the Worker variables and secrets.' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      });
    }
  },
  async scheduled(controller, env, ctx) {
    initializeConfig(env);
    ctx.waitUntil(runMaintenance());
  }
};
