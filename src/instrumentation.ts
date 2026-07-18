export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startAutomationScheduler } = await import('./lib/automation-engine');
      startAutomationScheduler();
      console.log('[Instrumentation] Auto-started background automation scheduler.');
    } catch (e) {
      console.error('[Instrumentation] Failed to register automation:', e);
    }
  }
}
