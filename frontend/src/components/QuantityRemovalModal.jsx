import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X, Video, AlertTriangle } from 'lucide-react'
import { packingAPI } from '../services/api'
import { uploadFileToStorage } from '../hooks/useStorageUpload'
import { pickRecordingBitrate } from '../utils/videoRecordingProfile'

const DEFAULT_REASONS = [
  { value: 'stock_issue', label: 'Stock issue' },
  { value: 'quality', label: 'Quality problem' },
  { value: 'cancellation', label: 'Cancellation' },
  { value: 'damage', label: 'Damage' },
  { value: 'invoice_change', label: 'Invoice change' },
  { value: 'warehouse_instruction', label: 'Warehouse instruction' },
  { value: 'other', label: 'Other operational reason' },
]

/**
 * Box-wise post-packing quantity removal with mandatory evidence video.
 */
export default function QuantityRemovalModal({
  open,
  consignmentId,
  boxNo,
  displayConsignmentId,
  mediaStream,
  onClose,
  onCompleted,
  toast,
}) {
  const [loading, setLoading] = useState(false)
  const [context, setContext] = useState(null)
  const [skuId, setSkuId] = useState('')
  const [removeQty, setRemoveQty] = useState('')
  const [reason, setReason] = useState('')
  const [remarks, setRemarks] = useState('')
  const [recording, setRecording] = useState(false)
  const [recordedBlob, setRecordedBlob] = useState(null)
  const [recSeconds, setRecSeconds] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [pendingAdjustment, setPendingAdjustment] = useState(null)
  const [stepError, setStepError] = useState('')

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const clientRequestIdRef = useRef(null)
  const previewRef = useRef(null)

  const reasons = context?.reasons?.length ? context.reasons : DEFAULT_REASONS
  const selectedItem = useMemo(
    () => (context?.items || []).find((item) => String(item.skuId) === String(skuId)),
    [context, skuId]
  )
  const packedQty = Number(selectedItem?.qty) || 0
  const qtyNum = Number(removeQty) || 0
  const finalQty = Math.max(0, packedQty - qtyNum)
  const canConfirmMath = skuId && qtyNum > 0 && qtyNum <= packedQty && reason
    && (reason !== 'other' || String(remarks || '').trim())

  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    setLoading(true)
    setStepError('')
    setRecordedBlob(null)
    setPendingAdjustment(null)
    setSkuId('')
    setRemoveQty('')
    setReason('')
    setRemarks('')
    setUploadProgress(0)
    clientRequestIdRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `removal_${Date.now()}_${Math.random().toString(36).slice(2)}`

    packingAPI.getBoxRemovalContext({ consignment_id: consignmentId, box_no: boxNo })
      .then((res) => {
        if (cancelled) return
        setContext(res.data)
        const first = (res.data?.items || [])[0]
        if (first) setSkuId(first.skuId)
        const pending = (res.data?.pending_adjustments || []).find((a) => a.status !== 'completed')
        if (pending) {
          setPendingAdjustment(pending)
          setSkuId(pending.skuId)
          setRemoveQty(String(pending.quantity))
          setReason(pending.reason || '')
          setRemarks(pending.remarks || '')
        }
      })
      .catch((err) => {
        if (!cancelled) {
          toast?.(err.response?.data?.error || 'Failed to load box details', 'error')
          onClose?.()
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
      stopRecordingInternal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open/box only
  }, [open, consignmentId, boxNo])

  useEffect(() => {
    if (!open || loading || !mediaStream || !previewRef.current) return
    previewRef.current.srcObject = mediaStream
  }, [open, mediaStream, loading])

  function stopRecordingInternal() {
    try {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
    } catch (_) { /* ignore */ }
    mediaRecorderRef.current = null
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    setRecording(false)
  }

  const startRemovalRecording = () => {
    setStepError('')
    if (!mediaStream) {
      setStepError('Camera must be active to record the removal video.')
      toast?.('Start the packing camera first', 'error')
      return
    }
    if (!canConfirmMath) {
      setStepError('Select SKU, quantity, and reason before recording.')
      return
    }

    chunksRef.current = []
    setRecordedBlob(null)
    setRecSeconds(0)

    const mimeCandidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]
    let mimeType = ''
    for (const m of mimeCandidates) {
      if (MediaRecorder.isTypeSupported(m)) {
        mimeType = m
        break
      }
    }

    const track = mediaStream.getVideoTracks?.()[0]
    const settings = track?.getSettings?.() || {}
    const bitrate = pickRecordingBitrate(settings.width || 1280, settings.height || 720)
    const opts = { videoBitsPerSecond: bitrate }
    if (mimeType) opts.mimeType = mimeType

    try {
      const recorder = new MediaRecorder(mediaStream, opts)
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunksRef.current.push(e.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || 'video/webm' })
        setRecordedBlob(blob)
        setRecording(false)
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      }
      recorder.start(1000)
      setRecording(true)
      timerRef.current = setInterval(() => setRecSeconds((s) => s + 1), 1000)
      toast?.('Recording removal — show box, SKU, and pieces being removed', 'info', 4000)
    } catch (err) {
      setStepError(err.message || 'Could not start recorder')
      toast?.('Could not start removal recorder', 'error')
    }
  }

  const stopRemovalRecording = () => {
    stopRecordingInternal()
  }

  const handleConfirm = async () => {
    if (submitting) return
    setStepError('')
    if (!canConfirmMath) {
      setStepError('Select SKU, enter a valid quantity, and choose a reason.')
      return
    }
    if (!recordedBlob && !pendingAdjustment?.videoId) {
      setStepError('Record and stop the removal video before confirming.')
      return
    }

    setSubmitting(true)
    setUploadProgress(0)
    try {
      let adjustment = pendingAdjustment
      if (!adjustment || adjustment.status === 'completed') {
        const createRes = await packingAPI.createQuantityRemoval({
          consignment_id: consignmentId,
          box_no: boxNo,
          sku_id: skuId,
          quantity: qtyNum,
          reason,
          remarks,
          client_request_id: clientRequestIdRef.current,
        })
        adjustment = createRes.data.adjustment
        setPendingAdjustment(adjustment)
        if (createRes.data.invoice_warning) {
          toast?.(createRes.data.invoice_warning, 'warning', 7000)
        }
      }

      if (!adjustment.videoId) {
        if (!recordedBlob) {
          setStepError('Removal video is required.')
          setSubmitting(false)
          return
        }
        const ext = (recordedBlob.type || '').includes('mp4') ? 'mp4' : 'webm'
        const file = new File(
          [recordedBlob],
          `${consignmentId}_box_${boxNo}_removal_${adjustment.id}.${ext}`,
          { type: recordedBlob.type || 'video/webm' }
        )
        const uploaded = await uploadFileToStorage(
          file,
          consignmentId,
          'removal_video',
          boxNo,
          setUploadProgress,
          {
            adjustmentId: adjustment.id,
            purpose: 'quantity_removal',
            description: `Box ${boxNo} quantity removal — ${selectedItem?.internalSku || skuId}`,
            clientUploadId: `removal_${adjustment.id}`,
          }
        )
        if (!uploaded?.id) {
          throw new Error('Video upload did not return a file id')
        }
        const attachRes = await packingAPI.attachQuantityRemovalVideo(adjustment.id, {
          video_id: uploaded.id,
        })
        adjustment = attachRes.data.adjustment
        setPendingAdjustment(adjustment)
      }

      const completeRes = await packingAPI.completeQuantityRemoval(adjustment.id)
      if (completeRes.data.invoice_warning) {
        toast?.(completeRes.data.invoice_warning, 'warning', 8000)
      }
      toast?.(
        `Removed ${qtyNum} from Box ${boxNo} — final ${completeRes.data.adjustment?.finalQty ?? finalQty}`,
        'success',
        5000
      )
      onCompleted?.(completeRes.data)
      onClose?.()
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Removal failed'
      setStepError(msg)
      toast?.(msg, 'error', 6000)
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const history = context?.history
  const cidLabel = displayConsignmentId || context?.internal_shipment_no || consignmentId

  return (
    <div
      className="fixed inset-0 z-[10020] flex items-center justify-center p-3 overflow-y-auto"
      style={{ background: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(8px)' }}
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-[640px] my-4 overflow-hidden flex flex-col max-h-[92vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="h-1 w-full bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 flex-shrink-0" />
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-extrabold text-slate-900">Remove Quantity</h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Box {boxNo} · {cidLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg border border-slate-200/60 bg-white"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 text-[12.5px] text-slate-700">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading box details…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">Consignment</div>
                  <div className="font-bold text-slate-800 truncate">{cidLabel}</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">Box</div>
                  <div className="font-bold text-slate-800">{boxNo}</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">Current total</div>
                  <div className="font-bold text-slate-800">{context?.total_qty ?? 0} pcs</div>
                </div>
                <div className="rounded-lg bg-slate-50 border border-slate-100 p-2.5">
                  <div className="text-[9px] uppercase tracking-wide text-slate-400 font-semibold">OMS</div>
                  <div className="font-bold text-amber-700">{history?.omsAdjustment || 'Pending'}</div>
                </div>
              </div>

              {context?.invoice_generated && (
                <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold text-[12px]">Invoice already generated</div>
                    <div className="text-[11px] mt-0.5 leading-relaxed">
                      Quantity removal will require invoice correction or approval. Dispatch stays blocked until quantities match (unless an authorized exception is approved).
                    </div>
                  </div>
                </div>
              )}

              {history && (
                <div className="rounded-lg border border-slate-200 p-3 bg-white">
                  <div className="text-[11px] font-bold text-slate-800 mb-2">Box {boxNo} history</div>
                  <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-600">
                    <li>Originally packed: <strong>{history.originallyPacked}</strong></li>
                    <li>Added later: <strong>{history.addedLater}</strong></li>
                    <li>Removed later: <strong>{history.removedLater}</strong></li>
                    <li>Final quantity: <strong>{history.finalQuantity}</strong></li>
                  </ul>
                </div>
              )}

              <div>
                <div className="text-[11px] font-bold text-slate-800 mb-1.5">SKU-wise packed quantities</div>
                <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[140px] overflow-y-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-semibold">SKU</th>
                        <th className="text-left px-2 py-1.5 font-semibold">Barcode</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(context?.items || []).map((item) => (
                        <tr
                          key={item.skuId}
                          className={`border-t border-slate-100 cursor-pointer ${String(item.skuId) === String(skuId) ? 'bg-primary-50' : 'hover:bg-slate-50'}`}
                          onClick={() => setSkuId(item.skuId)}
                        >
                          <td className="px-2 py-1.5 font-medium text-slate-800">{item.internalSku || item.skuId}</td>
                          <td className="px-2 py-1.5 text-slate-500">{item.barcode || item.marketplaceSku || '—'}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">{item.qty}</td>
                        </tr>
                      ))}
                      {!context?.items?.length && (
                        <tr><td colSpan={3} className="px-2 py-3 text-center text-slate-400">No items in this box</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {(context?.packing_videos || []).length > 0 && (
                <div className="text-[11px] text-slate-600">
                  Original packing video: <span className="font-semibold text-emerald-700">Available</span>
                  {' '}({context.packing_videos.length})
                </div>
              )}

              <div className="grid sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] uppercase font-semibold text-slate-400">SKU to remove from</span>
                  <select
                    value={skuId}
                    onChange={(e) => setSkuId(e.target.value)}
                    className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-2 text-[12px] bg-white"
                    disabled={submitting}
                  >
                    <option value="">Select SKU</option>
                    {(context?.items || []).map((item) => (
                      <option key={item.skuId} value={item.skuId}>
                        {item.internalSku || item.skuId} ({item.qty} pcs)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase font-semibold text-slate-400">Quantity to remove</span>
                  <input
                    type="number"
                    min={1}
                    max={packedQty || undefined}
                    value={removeQty}
                    onChange={(e) => setRemoveQty(e.target.value)}
                    className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-2 text-[12px]"
                    disabled={submitting}
                  />
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-[10px] uppercase font-semibold text-slate-400">Removal reason</span>
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-2 text-[12px] bg-white"
                    disabled={submitting}
                  >
                    <option value="">Select reason</option>
                    {reasons.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className="text-[10px] uppercase font-semibold text-slate-400">Remarks</span>
                  <textarea
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    rows={2}
                    className="mt-1 w-full border border-slate-200 rounded-lg px-2.5 py-2 text-[12px] resize-none"
                    placeholder="Optional notes"
                    disabled={submitting}
                  />
                </label>
              </div>

              {canConfirmMath && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[12px] text-slate-800">
                  {packedQty} packed − {qtyNum} removed = <strong>{finalQty} final pieces</strong>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-800">
                    <Video className="w-3.5 h-3.5" /> Mandatory removal video
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {recording ? `REC ${String(Math.floor(recSeconds / 60)).padStart(2, '0')}:${String(recSeconds % 60).padStart(2, '0')}` : (recordedBlob ? 'Ready to upload' : 'Not recorded')}
                  </div>
                </div>
                <div className="relative bg-slate-900 aspect-video">
                  <video ref={previewRef} autoPlay muted playsInline className="w-full h-full object-cover opacity-90" />
                  {recording && (
                    <div className="absolute top-2 left-2 flex items-center gap-1.5 bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded">
                      <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" /> REC
                    </div>
                  )}
                </div>
                <div className="px-3 py-2.5 flex flex-wrap gap-2 bg-white">
                  {!recording ? (
                    <button
                      type="button"
                      onClick={startRemovalRecording}
                      disabled={submitting || !canConfirmMath}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-red-600 text-white disabled:opacity-50"
                    >
                      {recordedBlob ? 'Re-record' : 'Start recording'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={stopRemovalRecording}
                      className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 text-white"
                    >
                      Stop recording
                    </button>
                  )}
                  <span className="text-[10px] text-slate-500 self-center">
                    Capture box number, SKU, physical removal, and remaining contents.
                  </span>
                </div>
              </div>

              {stepError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700 text-[11px]">
                  {stepError}
                </div>
              )}

              {submitting && uploadProgress > 0 && uploadProgress < 100 && (
                <div className="text-[11px] text-slate-600">
                  Uploading removal video… {uploadProgress}%
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-primary-600 transition-all" style={{ width: `${uploadProgress}%` }} />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 flex gap-2 justify-end bg-slate-50/80">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-[11px] font-medium bg-white hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || loading || !canConfirmMath || (!recordedBlob && !pendingAdjustment?.videoId)}
            className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-[11px] font-semibold disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Confirm removal
          </button>
        </div>
      </div>
    </div>
  )
}
