import { setState, listState } from '../memory/world_state_store.mjs';
import { runWatchdog } from '../memory/contradiction_watchdog.mjs';

// Configure environment for the watchdog
process.env.WATCHDOG_ENABLED = '1';
process.env.WATCHDOG_COOLDOWN_MS = '0';
process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';

// Seed a hard rule and probe
setState('demo', 'door', 'locked', 'fact');

const userText = 'I open the door and walk through.';
const result = runWatchdog({ convId: 'demo', userText });

console.log('states:', listState('demo'));
console.log('result:', result);

