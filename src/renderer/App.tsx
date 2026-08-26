import { useEffect, useMemo, useState } from "react"
import type { Appearance } from "@moirasia/desktop-shell"
import { AppearanceScope, AppearanceToggle, DesktopAppShell, DesktopContentHeader, DesktopPage, useProductAppearance } from "@moirasia/desktop-shell/react"
import { Alert, AlertDescription, AlertTitle } from "@moirasia/ui-react/components/alert"
import { Badge } from "@moirasia/ui-react/components/badge"
import { Button } from "@moirasia/ui-react/components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@moirasia/ui-react/components/card"
import { Progress } from "@moirasia/ui-react/components/progress"
import { AlertCircle, ChevronLeft, RefreshCw, Square } from "@moirasia/ui-react/lib/icons"
import type { ChartSegment, NodeSummary, OrbisApi, OrbisSnapshot } from "../shared/contracts"
import { Sunburst, formatBytes } from "./Sunburst"

interface SelectedNode {
  readonly id: string | null
  readonly name: string
  readonly kind: "directory" | "file" | "other"
  readonly sizeBytes: number
  readonly percentage: number
  readonly scanState: NodeSummary["scanState"]
  readonly sizeAccuracy: NodeSummary["sizeAccuracy"]
}

export function App(): React.JSX.Element {
  const [appearance, setAppearance] = useProductAppearance(window.desktopShell)
  return <DesktopAppShell product="Orbis" appearance={appearance} onAppearanceChange={setAppearance}>
    <OrbisPanel bridge={window.orbis} appearance={appearance} onAppearanceChange={setAppearance} />
  </DesktopAppShell>
}

export interface OrbisPanelProps {
  readonly bridge: OrbisApi
  readonly appearance: Appearance
  readonly onAppearanceChange: (appearance: Appearance) => void
  readonly embeddedHeader?: boolean
}

/** Orbis content shared by the standalone window and the Moirasia shell. */
export function OrbisPanel({ bridge, appearance, onAppearanceChange, embeddedHeader = false }: OrbisPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<OrbisSnapshot>()
  const [selected, setSelected] = useState<SelectedNode>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const unsubscribe = bridge.subscribe((next) => { if (alive) { setSnapshot(next); setError(undefined) } })
    void bridge.getSnapshot().then((next) => { if (alive) setSnapshot(next) }).catch((reason: unknown) => { if (alive) setError(message(reason)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false; unsubscribe() }
  }, [bridge])

  const run = async (operation: () => Promise<OrbisSnapshot>): Promise<void> => {
    setError(undefined)
    try { setSnapshot(await operation()) }
    catch (reason) { setError(message(reason)) }
  }

  useEffect(() => {
    if (!snapshot || !selected?.id) return
    const segment = snapshot.chart.find((item) => item.id === selected.id)
    const item = snapshot.largestItems.find((candidate) => candidate.id === selected.id)
    const next = segment && segment.id !== null
      ? { id: segment.id, name: segment.name, kind: segment.kind === "file" ? "file" as const : "directory" as const, sizeBytes: segment.sizeBytes, percentage: segment.percentage, scanState: segment.scanState, sizeAccuracy: segment.sizeAccuracy }
      : item && snapshot.focus
        ? { id: item.id, name: item.name, kind: item.kind, sizeBytes: item.sizeBytes, percentage: snapshot.focus.sizeBytes > 0 ? item.sizeBytes / snapshot.focus.sizeBytes * 100 : 0, scanState: item.scanState, sizeAccuracy: item.sizeAccuracy }
        : undefined
    if (!next) setSelected(undefined)
    else if (next.sizeBytes !== selected.sizeBytes || next.percentage !== selected.percentage || next.name !== selected.name || next.scanState !== selected.scanState || next.sizeAccuracy !== selected.sizeAccuracy) setSelected(next)
  }, [snapshot, selected])

  const focus = snapshot?.focus
  const scan = snapshot?.scan
  const isScanning = scan?.status === "scanning"
  const diskRoot = Boolean(focus && snapshot?.target.isStartup && focus.id === snapshot.breadcrumbs[0]?.id)
  const displayTotal = useMemo(() => focus && snapshot ? (diskRoot ? snapshot.volume.capacityBytes : focus.sizeBytes) : 0, [diskRoot, focus, snapshot])
  const diskUsagePercentage = diskRoot && focus && displayTotal > 0
    ? (isPending(focus) ? focus.estimatedSizeBytes ?? focus.sizeBytes : focus.sizeBytes) / displayTotal * 100
    : undefined
  const selectedPercent = selected ? selected.percentage : 0
  const startOrRescan = !scan || scan.status === "idle" ? bridge.startScan : bridge.rescan
  const startOrRescanLabel = scan?.resume?.available ? "Resume" : !scan || scan.status === "idle" ? "Scan" : "Rescan"

  const activateSegment = (segment: ChartSegment): void => {
    const segmentId = segment.id
    if (segment.kind === "directory") {
      if (!segment.drillable || !segmentId) return
      setSelected(undefined)
      void run(() => bridge.focusNode(segmentId))
      return
    }
    if (segment.kind === "file" && segmentId) setSelected({ id: segment.id, name: segment.name, kind: "file", sizeBytes: segment.sizeBytes, percentage: segment.percentage, scanState: segment.scanState, sizeAccuracy: segment.sizeAccuracy })
  }
  const selectLargest = (item: NodeSummary): void => {
    const percentage = displayTotal > 0 ? (item.sizeBytes / displayTotal) * 100 : 0
    if (item.kind === "directory" && (item.directChildren > 0 || item.scanState !== "complete")) {
      setSelected(undefined)
      void run(() => bridge.focusNode(item.id))
    } else setSelected({ id: item.id, name: item.name, kind: item.kind, sizeBytes: item.sizeBytes, percentage, scanState: item.scanState, sizeAccuracy: item.sizeAccuracy })
  }

  return <AppearanceScope appearance={appearance} className="orbis-feature-panel">
    {embeddedHeader && <header className="orbis-feature-panel__header"><strong>Orbis</strong><AppearanceToggle value={appearance} onChange={onAppearanceChange} /></header>}
    <DesktopPage width="full" scroll="contained" className="orbis-feature-panel__page">
      <DesktopContentHeader title="Disk usage" description={snapshot ? `Scanning ${snapshot.target.name}` : "Read-only storage visualizer"} actions={<div className="orbis-feature-panel__actions">
        <Button size="sm" variant="outline" onClick={() => void run(() => bridge.chooseFolder())}>Choose Folder</Button>
        {isScanning ? <Button size="sm" variant="outline" onClick={() => void run(() => bridge.cancelScan())}><Square />Pause</Button> : <Button size="sm" onClick={() => void run(startOrRescan)}>{scan?.status === "idle" ? null : <RefreshCw />}{startOrRescanLabel}</Button>}
      </div>} />
      {error && <Alert variant="destructive" className="orbis-feature-panel__alert"><AlertCircle /><AlertTitle>Orbis could not complete that action</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {loading && <div className="orbis-feature-panel__state" role="status">Loading Orbis…</div>}
      {!loading && snapshot && <>
        <ScanStatus snapshot={snapshot} onCancel={() => void run(() => bridge.cancelScan())} onRescan={() => void run(() => bridge.rescan())} />
        {snapshot.scan.status === "fatal-error" && <Alert variant="destructive" className="orbis-feature-panel__alert"><AlertCircle /><AlertTitle>Scan failed</AlertTitle><AlertDescription><span>{snapshot.scan.error ?? "Orbis could not read this folder."}</span><Button size="sm" variant="outline" onClick={() => void run(async () => { await bridge.openFullDiskAccess(); return snapshot })}>Open Full Disk Access</Button></AlertDescription></Alert>}
        {(snapshot.scan.status === "canceled" || snapshot.scan.resume?.available && snapshot.scan.status === "fatal-error") && <Alert className="orbis-feature-panel__alert"><AlertTitle>{snapshot.scan.resume?.available ? "Scan paused — progress saved" : "Scan canceled"}</AlertTitle><AlertDescription><span>{snapshot.scan.resume?.available ? "Orbis will resume from the last completed directory checkpoint." : "The last completed index remains available. Rescan when you are ready."}</span>{snapshot.scan.resume?.available && <Button size="sm" variant="outline" onClick={() => void run(() => bridge.discardSavedScan())}>Discard saved scan</Button>}</AlertDescription></Alert>}
        {snapshot.scan.totals && (snapshot.scan.totals.unreadableItems > 0 || snapshot.scan.totals.skippedItems > 0) && <PermissionWarning snapshot={snapshot} onOpen={() => void run(async () => { await bridge.openFullDiskAccess(); return snapshot })} />}
        {snapshot.committed && snapshot.volume.sizeAccuracy === "partial" && <Alert className="orbis-feature-panel__alert"><AlertTitle>Scan complete; some folders could not be measured</AlertTitle><AlertDescription>Orbis indexed the readable metadata and marked the remaining sizes as partial.</AlertDescription></Alert>}
        <VolumeSummary snapshot={snapshot} />
        {focus ? <div className="orbis-feature-panel__workspace">
          <section className="orbis-feature-panel__chart-panel" aria-labelledby="chart-heading">
            <div className="orbis-feature-panel__panel-heading"><div><p className="orbis-feature-panel__eyebrow">LOCATION</p><h2 id="chart-heading">{focus.name}</h2><FolderSize node={focus} /></div>{focus.parentId && <Button size="sm" variant="ghost" onClick={() => void run(() => bridge.focusNode(focus.parentId!))}><ChevronLeft />Up</Button>}</div>
            <Breadcrumbs snapshot={snapshot} onFocus={(id) => void run(() => bridge.focusNode(id))} />
            {focus.directChildren === 0 && focus.scanState === "complete" && !(diskRoot && snapshot.volume.unscannedBytes > 0) ? <div className="orbis-feature-panel__empty" role="status"><strong>This folder is empty</strong><span>No readable child files or folders were found.</span></div> : <Sunburst segments={snapshot.chart} onActivate={activateSegment} provisionalState={focus.scanState} diskUsagePercentage={diskUsagePercentage} />}
          </section>
          <Inspector snapshot={snapshot} selected={selected} selectedPercent={selectedPercent} percentageContext={diskRoot ? "disk capacity" : "this folder"} onSelect={selectLargest} onReveal={() => selected?.id && void run(async () => { await bridge.revealNode(selected.id!); return snapshot })} />
        </div> : <EmptyScanState snapshot={snapshot} onStart={() => void run(() => bridge.startScan())} />}
      </>}
    </DesktopPage>
  </AppearanceScope>
}

function ScanStatus({ snapshot, onCancel, onRescan }: { readonly snapshot: OrbisSnapshot; readonly onCancel: () => void; readonly onRescan: () => void }): React.JSX.Element {
  const progress = snapshot.scan.progress
  const percent = progress && snapshot.volume.scannedBytes > 0 ? Math.min(99, progress.discoveredBytes / Math.max(progress.discoveredBytes, snapshot.volume.scannedBytes) * 100) : progress ? Math.min(95, progress.scannedItems > 0 ? 8 + Math.log10(progress.scannedItems + 1) * 12 : 4) : snapshot.scan.status === "completed" ? 100 : 0
  return <div className="orbis-feature-panel__scan-status" aria-live="polite">
    <div className="orbis-feature-panel__scan-status-copy" data-committed={snapshot.committed}><strong>{snapshot.scan.status === "scanning" ? progress?.stage === "indexing" ? "Building index…" : "Scanning…" : snapshot.scan.status === "completed" ? "Scan complete" : snapshot.scan.status === "canceled" ? snapshot.scan.resume?.available ? "Scan paused — progress saved" : "Scan canceled" : snapshot.scan.status === "fatal-error" ? "Scan unavailable" : "Waiting to scan"}</strong><span>{progress ? `${progress.scannedItems.toLocaleString()} items · ${formatBytes(progress.discoveredBytes)} · ${progress.currentItem}` : snapshot.scan.totals ? `${snapshot.scan.totals.scannedItems.toLocaleString()} items · ${formatBytes(snapshot.scan.totals.discoveredBytes)} in ${(snapshot.scan.totals.elapsedMs / 1000).toFixed(1)}s` : snapshot.committed ? "Committed index" : "Live preview"}</span></div>
    {snapshot.scan.status === "scanning" ? <><Progress value={percent} max={100} className="orbis-feature-panel__scan-progress" /><Button size="sm" variant="outline" onClick={onCancel}>Pause</Button></> : snapshot.scan.status === "canceled" ? <Button size="sm" onClick={onRescan}>{snapshot.scan.resume?.available ? "Resume" : "Rescan"}</Button> : null}
  </div>
}

function PermissionWarning({ snapshot, onOpen }: { readonly snapshot: OrbisSnapshot; readonly onOpen: () => void }): React.JSX.Element {
  const totals = snapshot.scan.totals!
  return <Alert className="orbis-feature-panel__alert orbis-feature-panel__permission-warning"><AlertCircle /><AlertTitle>Some paths were skipped</AlertTitle><AlertDescription><span>{totals.skippedItems.toLocaleString()} item{totals.skippedItems === 1 ? "" : "s"} could not be included. Protected or unreadable paths remain in unscanned space.</span><Button size="sm" variant="outline" onClick={onOpen}>Open Full Disk Access</Button></AlertDescription></Alert>
}

function VolumeSummary({ snapshot }: { readonly snapshot: OrbisSnapshot }): React.JSX.Element {
  const { capacityBytes, freeBytes, scannedBytes, unscannedBytes, sizeAccuracy } = snapshot.volume
  return <div className="orbis-feature-panel__volume-summary" aria-label={`Storage summary, ${accuracyLabel(sizeAccuracy, snapshot.focus?.scanState ?? "queued")}`}>
    <Metric label="Capacity" value={formatBytes(capacityBytes)} />
    <Metric label="Free" value={formatBytes(freeBytes)} />
    <Metric label="Readable scanned" value={formatBytes(scannedBytes)} />
    {unscannedBytes > 0 && <Metric label="Unscanned or system data" value={formatBytes(unscannedBytes)} muted />}
  </div>
}

function Metric({ label, value, muted = false }: { readonly label: string; readonly value: string; readonly muted?: boolean }): React.JSX.Element {
  return <div className={`orbis-feature-panel__volume-metric${muted ? " orbis-feature-panel__volume-metric--muted" : ""}`}><span>{label}</span><strong>{value}</strong></div>
}

function FolderSize({ node }: { readonly node: NodeSummary }): React.JSX.Element {
  const value = formatBytes(isPending(node) ? node.estimatedSizeBytes ?? node.sizeBytes : node.sizeBytes)
  const label = node.sizeAccuracy === "estimated" ? "Estimated size" : node.sizeAccuracy === "exact" ? "Size" : "Known size"
  const accessibleLabel = node.sizeAccuracy === "estimated" ? `Estimated folder size, ${value}` : node.sizeAccuracy === "exact" ? `Folder size, ${value}` : `Known folder size, ${value}`
  return <p className="orbis-feature-panel__folder-size" aria-label={accessibleLabel}><span>{label}</span><strong>{value}</strong></p>
}

function Breadcrumbs({ snapshot, onFocus }: { readonly snapshot: OrbisSnapshot; readonly onFocus: (id: string) => void }): React.JSX.Element {
  return <nav className="orbis-feature-panel__breadcrumbs" aria-label="Folder breadcrumbs">{snapshot.breadcrumbs.map((breadcrumb, index) => <span key={breadcrumb.id}><button type="button" onClick={() => onFocus(breadcrumb.id)} aria-current={index === snapshot.breadcrumbs.length - 1 ? "location" : undefined}>{breadcrumb.name}</button>{index < snapshot.breadcrumbs.length - 1 && <span aria-hidden="true">/</span>}</span>)}</nav>
}

function Inspector({ snapshot, selected, selectedPercent, percentageContext, onSelect, onReveal }: { readonly snapshot: OrbisSnapshot; readonly selected: SelectedNode | undefined; readonly selectedPercent: number; readonly percentageContext: "disk capacity" | "this folder"; readonly onSelect: (item: NodeSummary) => void; readonly onReveal: () => void }): React.JSX.Element {
  return <aside className="orbis-feature-panel__inspector" aria-labelledby="largest-heading">
    {selected ? <Card className="orbis-feature-panel__selection-card"><CardHeader><div className="orbis-feature-panel__panel-heading"><div><p className="orbis-feature-panel__eyebrow">SELECTED ITEM</p><CardTitle>{selected.name}</CardTitle></div><Badge variant="outline">{selected.kind}</Badge></div><CardDescription>{formatBytes(selected.sizeBytes)} · {selectedPercent.toFixed(1)}% of {percentageContext} · {accuracyLabel(selected.sizeAccuracy, selected.scanState)}</CardDescription></CardHeader><CardContent><Button size="sm" variant="outline" disabled={!selected.id} onClick={onReveal}>Reveal in Finder</Button></CardContent></Card> : <Card className="orbis-feature-panel__selection-card orbis-feature-panel__selection-card--empty"><CardHeader><CardTitle>Select an item</CardTitle><CardDescription>Choose a file in the chart or list to see its size and reveal it in Finder.</CardDescription></CardHeader></Card>}
    <Card className="orbis-feature-panel__largest-card"><CardHeader><CardTitle id="largest-heading">Largest items</CardTitle><CardDescription>Direct children of {snapshot.focus?.name ?? snapshot.target.name}, sorted by allocated space.</CardDescription></CardHeader><CardContent>{snapshot.largestItems.length === 0 ? <p className="orbis-feature-panel__muted">No readable items in this folder.</p> : <ul className="orbis-feature-panel__largest-list">{snapshot.largestItems.map((item) => { const size = nodeSizePresentation(item); return <li key={item.id}><button type="button" onClick={() => onSelect(item)} aria-label={`${item.name}, ${item.kind}, ${size.accessible}`}><span className="orbis-feature-panel__largest-list-name"><span className={`orbis-feature-panel__node-dot orbis-feature-panel__node-dot--${item.kind}`} aria-hidden="true" />{item.name}</span><span className="orbis-feature-panel__largest-list-size">{size.visible}</span></button></li> })}</ul>}</CardContent></Card>
  </aside>
}

function EmptyScanState({ snapshot, onStart }: { readonly snapshot: OrbisSnapshot; readonly onStart: () => void }): React.JSX.Element {
  return <div className="orbis-feature-panel__empty orbis-feature-panel__empty--large"><h2>No completed scan</h2><p>{snapshot.scan.error ?? "Orbis has not indexed a folder yet."}</p><Button onClick={onStart}>Scan {snapshot.target.name}</Button></div>
}

function nodeSizePresentation(node: NodeSummary): { readonly visible: string; readonly accessible: string } {
  const value = formatBytes(isPending(node) ? node.estimatedSizeBytes ?? node.sizeBytes : node.sizeBytes)
  return { visible: value, accessible: `${value}, ${accuracyLabel(node.sizeAccuracy, node.scanState)}` }
}

function isPending(node: Pick<NodeSummary, "scanState">): boolean { return node.scanState === "queued" || node.scanState === "scanning" }

function accuracyLabel(accuracy: NodeSummary["sizeAccuracy"] | undefined, state: NodeSummary["scanState"]): string {
  if (accuracy === undefined) return state === "queued" ? "Queued" : state === "scanning" ? "Scanning" : state === "unreadable" ? "Unreadable" : "Complete"
  if (accuracy === "estimated") return "Estimated"
  if (accuracy === "exact") return "Exact"
  if (state === "queued" || state === "scanning") return "Scanning"
  return "Partial"
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
