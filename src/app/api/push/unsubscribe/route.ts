import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteDeviceById, deleteSubscription } from '@/lib/push/server'

const ID_RE = /^[0-9a-fA-F-]{8,64}$/

// Removes one of YOUR devices, by endpoint (this browser) or by device id
// (from the device list in Settings).
export async function POST(request: Request) {
  try {
    const { userId } = await requireRole('viewer')
    const body = await request.json().catch(() => null)
    if (typeof body?.id === 'string' && ID_RE.test(body.id)) {
      await deleteDeviceById(userId, body.id)
      return NextResponse.json({ ok: true })
    }
    if (typeof body?.endpoint !== 'string' || body.endpoint.length > 2048) {
      return NextResponse.json({ error: 'endpoint or id required' }, { status: 400 })
    }
    await deleteSubscription(userId, body.endpoint)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
