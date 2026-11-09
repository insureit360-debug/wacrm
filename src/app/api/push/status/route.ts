import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkVapid, getLastPushAttempt, listDevices } from '@/lib/push/server'

// GET /api/push/status — everything the Settings checker needs to know about
// the SERVER side of notifications. Never returns any secret.
export async function GET() {
  try {
    const { accountId, userId } = await requireRole('viewer')
    const vapid = checkVapid()
    const devices = vapid.configured ? await listDevices(accountId, userId) : []
    return NextResponse.json({
      vapid,
      devices,
      lastPush: getLastPushAttempt(),
      serverTime: new Date().toISOString(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
