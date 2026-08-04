export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startReconciliationCron } = await import('@/lib/mercadolivre/cron')
    startReconciliationCron()
  }
}
