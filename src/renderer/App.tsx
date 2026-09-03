import { useEffect, useMemo, useRef, useState } from "react"
import type { Appearance } from "@moirasia/desktop-shell"
import { AppearanceScope, DesktopAppShell, DesktopContentHeader, DesktopPage, useProductAppearance } from "@moirasia/desktop-shell/react"
import { Alert, AlertDescription, AlertTitle } from "@moirasia/ui-react/components/alert"
import { Button } from "@moirasia/ui-react/components/button"
import { Progress } from "@moirasia/ui-react/components/progress"
import { AlertCircle, ChevronLeft, RefreshCw, Square } from "@moirasia/ui-react/lib/icons"
import type { ChartSegment, LocationId, NodeSummary, OrbisApi, OrbisSnapshot } from "../shared/contracts"
import { formatBytes } from "./format-bytes"
import { scanStatusPresentation } from "./scan-presentation"
import { segmentColor, Sunburst } from "./Sunburst"
import type { SunburstTransition, SunburstTransitionOrigin } from "./Sunburst"

type PendingFolderTransition =
  | {
      readonly kind: "enter"
      readonly targetId: string
      readonly origin: SunburstTransitionOrigin
      readonly sourceSegments: readonly ChartSegment[]
      readonly branchId: string
    }
  | {
      readonly kind: "exit"
      readonly targetId: string
      readonly branchId: string
      readonly outgoingSegments: readonly ChartSegment[]
    }

export function App(): React.JSX.Element {
  const [appearance, setAppearance] = useProductAppearance(window.desktopShell)
  return <DesktopAppShell product="Orbis" appearance={appearance} onAppearanceChange={setAppearance}>
    <OrbisPanel bridge={window.orbis} appearance={appearance} />
  </DesktopAppShell>
}

export interface OrbisPanelProps {
  readonly bridge: OrbisApi
  readonly appearance: Appearance
}

/** Orbis content shared by the standalone window and the Moirasia shell. */
export function OrbisPanel({ bridge, appearance }: OrbisPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<OrbisSnapshot>()
  const [pendingFolderTransition, setPendingFolderTransition] = useState<PendingFolderTransition>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const notificationVersion = useRef(0)
  const commandVersion = useRef(0)

  useEffect(() => {
    let alive = true
    const requestedAt = notificationVersion.current
    const unsubscribe = bridge.subscribe((next) => {
      notificationVersion.current += 1
      if (alive) { setSnapshot((current) => preferNewerSnapshot(current, next)); setError(undefined) }
    })
    void bridge.getSnapshot().then((next) => {
      if (alive && notificationVersion.current === requestedAt) setSnapshot((current) => preferNewerSnapshot(current, next))
    }).catch((reason: unknown) => { if (alive) setError(message(reason)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false; unsubscribe() }
  }, [bridge])

  const run = async (operation: () => Promise<OrbisSnapshot>): Promise<void> => {
    const command = ++commandVersion.current
    const requestedAt = notificationVersion.current
    setError(undefined)
    try {
      const next = await operation()
      if (commandVersion.current === command && notificationVersion.current === requestedAt) {
        setSnapshot((current) => preferNewerSnapshot(current, next))
      }
    } catch (reason) {
      if (commandVersion.current === command) {
        setPendingFolderTransition(undefined)
        setError(message(reason))
      }
    }
  }

  const focus = snapshot?.focus
  const scan = snapshot?.scan
  const selectedLocation = snapshot?.locations.find((location) => location.id === snapshot.selectedLocationId)
  const isScanning = scan?.status === "scanning"
  const diskRoot = Boolean(focus && snapshot?.target.isStartup && focus.id === snapshot.breadcrumbs[0]?.id)
  const displayTotal = useMemo(() => focus && snapshot ? (diskRoot ? snapshot.volume.capacityBytes : focus.sizeBytes) : 0, [diskRoot, focus, snapshot])
  const diskUsagePercentage = diskRoot && focus && displayTotal > 0
    ? (isPending(focus) ? focus.estimatedSizeBytes ?? focus.sizeBytes : focus.sizeBytes) / displayTotal * 100
    : undefined
  const startOrRescan = !scan || scan.status === "idle" ? bridge.startScan : bridge.rescan
  const startOrRescanLabel = scan?.resume?.available ? "Resume" : !scan || scan.status === "idle" ? "Scan" : "Rescan"
  const exitDestination = pendingFolderTransition?.kind === "exit" && pendingFolderTransition.targetId === focus?.id
    ? snapshot?.chart.find((segment) => segment.depth === 1 && segment.id === pendingFolderTransition.branchId)
      ?? snapshot?.chart.find((segment) => segment.depth === 1 && segment.kind === "other")
    : undefined
  const chartTransition = useMemo<SunburstTransition | undefined>(() => {
    if (!pendingFolderTransition || pendingFolderTransition.targetId !== focus?.id) return undefined
    if (pendingFolderTransition.kind === "enter") return { kind: "enter", origin: pendingFolderTransition.origin, sourceSegments: pendingFolderTransition.sourceSegments, branchId: pendingFolderTransition.branchId }
    if (!exitDestination) return undefined
    return {
      kind: "exit",
      destination: { depth: exitDestination.depth, startAngle: exitDestination.startAngle, endAngle: exitDestination.endAngle },
      outgoingSegments: pendingFolderTransition.outgoingSegments,
      branchId: pendingFolderTransition.branchId
    }
  }, [exitDestination?.depth, exitDestination?.endAngle, exitDestination?.startAngle, focus?.id, pendingFolderTransition])

  useEffect(() => {
    if (pendingFolderTransition?.kind !== "exit" || pendingFolderTransition.targetId !== focus?.id || chartTransition) return
    setPendingFolderTransition((current) => current?.kind === "exit" && current.targetId === focus.id ? undefined : current)
  }, [chartTransition, focus?.id, pendingFolderTransition])

  const focusNode = (id: string, origin?: SunburstTransitionOrigin): void => {
    setPendingFolderTransition(origin ? { kind: "enter", targetId: id, origin, sourceSegments: snapshot?.chart ?? [], branchId: id } : undefined)
    void run(() => bridge.focusNode(id))
  }
  const exitToNode = (id: string): void => {
    if (!snapshot || id === focus?.id) return
    const destinationIndex = snapshot.breadcrumbs.findIndex((breadcrumb) => breadcrumb.id === id)
    const branch = snapshot.breadcrumbs[destinationIndex + 1]
    if (destinationIndex < 0 || !branch) {
      focusNode(id)
      return
    }
    setPendingFolderTransition({ kind: "exit", targetId: id, branchId: branch.id, outgoingSegments: snapshot.chart })
    void run(() => bridge.focusNode(id))
  }
  const activateSegment = (segment: ChartSegment): void => {
    const segmentId = segment.id
    if (segment.kind === "directory") {
      if (!segment.drillable || !segmentId) return
      focusNode(segmentId, segment)
      return
    }
    if (segment.kind === "file" && segmentId) void revealNode(segmentId)
  }
  const activateNode = (item: NodeSummary): void => {
    if (item.kind === "directory" && (item.directChildren > 0 || item.scanState !== "complete")) {
      const segment = snapshot?.chart.find((candidate) => candidate.id === item.id && candidate.depth === 1)
      focusNode(item.id, segment)
      return
    }
    void revealNode(item.id)
  }
  const revealNode = async (id: string): Promise<void> => {
    try {
      setError(undefined)
      await bridge.revealNode(id)
    } catch (reason) {
      setError(message(reason))
    }
  }
  const showNodeContextMenu = async (id: string): Promise<void> => {
    try {
      setError(undefined)
      await bridge.showNodeContextMenu(id)
    } catch (reason) {
      setError(message(reason))
    }
  }

  return <AppearanceScope appearance={appearance} className="orbis-feature-panel">
    <DesktopPage width="full" scroll="contained" className="orbis-feature-panel__page">
      <DesktopContentHeader title="Disk usage" description={snapshot ? `${snapshot.target.name}${selectedLocation?.coverage === "ancestor" ? " · Shared parent index" : ""}` : "Read-only storage visualizer"} actions={<div className="orbis-feature-panel__actions">
        {snapshot && <select aria-label="Saved location" value={snapshot.selectedLocationId} disabled={isScanning} onChange={(event) => void run(() => bridge.selectLocation(event.target.value as LocationId))}>{snapshot.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select>}
        <Button size="sm" variant="outline" onClick={() => void run(() => bridge.addLocation())} disabled={isScanning}>Add Folder</Button>
        {snapshot && <Button size="sm" variant="outline" aria-label="Remove location" disabled={snapshot.locations.length <= 1 || isScanning || Boolean(scan?.resume?.available && scan.locationId === snapshot.selectedLocationId)} onClick={() => void run(() => bridge.removeLocation(snapshot.selectedLocationId))}>Remove</Button>}
        {isScanning ? <Button size="sm" variant="outline" onClick={() => void run(() => bridge.cancelScan())}><Square />Pause</Button> : <Button size="sm" onClick={() => void run(startOrRescan)}>{scan?.status === "idle" ? null : <RefreshCw />}{startOrRescanLabel}</Button>}
      </div>} />
      {error && <Alert variant="destructive" className="orbis-feature-panel__alert"><AlertCircle /><AlertTitle>Orbis could not complete that action</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {loading && <div className="orbis-feature-panel__state" role="status">Loading Orbis…</div>}
      {!loading && snapshot && <>
        <ScanStatus snapshot={snapshot} onCancel={() => void run(() => bridge.cancelScan())} onRescan={() => void run(() => bridge.rescan())} onOpenPermissions={() => void run(async () => { await bridge.openFullDiskAccess(); return snapshot })} />
        {snapshot.scan.status === "fatal-error" && <Alert variant="destructive" className="orbis-feature-panel__alert"><AlertCircle /><AlertTitle>Scan failed</AlertTitle><AlertDescription><span>{snapshot.scan.error ?? "Orbis could not read this folder."}</span><Button size="sm" variant="outline" onClick={() => void run(async () => { await bridge.openFullDiskAccess(); return snapshot })}>Open Full Disk Access</Button></AlertDescription></Alert>}
        {(snapshot.scan.status === "canceled" || snapshot.scan.resume?.available && snapshot.scan.status === "fatal-error") && <Alert className="orbis-feature-panel__alert"><AlertTitle>{snapshot.scan.resume?.available ? "Scan paused — progress saved" : "Scan canceled"}</AlertTitle><AlertDescription><span>{snapshot.scan.resume?.available ? "Orbis will resume from the last completed directory checkpoint." : "The last completed index remains available. Rescan when you are ready."}</span>{snapshot.scan.resume?.available && <Button size="sm" variant="outline" onClick={() => void run(() => bridge.discardSavedScan())}>Discard saved scan</Button>}</AlertDescription></Alert>}
        {snapshot.committed && snapshot.volume.sizeAccuracy === "partial" && <Alert className="orbis-feature-panel__alert"><AlertTitle>Scan complete; some folders could not be measured</AlertTitle><AlertDescription>Orbis indexed the readable metadata and marked the remaining sizes as partial.</AlertDescription></Alert>}
        {focus ? <div className="orbis-feature-panel__workspace">
          <section className="orbis-feature-panel__chart-panel" aria-label={`Disk usage for ${focus.name}`}>
            <div className="orbis-feature-panel__panel-heading"><div className="orbis-feature-panel__location"><Breadcrumbs snapshot={snapshot} onFocus={exitToNode} onContextMenu={(id) => void showNodeContextMenu(id)} /><FolderSize node={focus} /></div>{focus.parentId && <Button size="sm" variant="ghost" onClick={() => exitToNode(focus.parentId!)}><ChevronLeft />Up</Button>}</div>
            {focus.directChildren === 0 && focus.scanState === "complete" && !(diskRoot && snapshot.volume.unscannedBytes > 0) ? <div className="orbis-feature-panel__empty" role="status"><strong>This folder is empty</strong><span>No readable child files or folders were found.</span></div> : <Sunburst segments={snapshot.chart} onActivate={activateSegment} onContextMenu={(segment) => { if (segment.id) void showNodeContextMenu(segment.id) }} provisionalState={focus.scanState} diskUsagePercentage={diskUsagePercentage} transition={chartTransition} onTransitionComplete={() => setPendingFolderTransition((current) => current?.targetId === focus.id ? undefined : current)} />}
          </section>
          <DirectoryContents snapshot={snapshot} onActivate={activateNode} onContextMenu={(id) => void showNodeContextMenu(id)} />
        </div> : <EmptyScanState snapshot={snapshot} onStart={() => void run(() => bridge.startScan())} />}
      </>}
    </DesktopPage>
  </AppearanceScope>
}

function preferNewerSnapshot(current: OrbisSnapshot | undefined, next: OrbisSnapshot): OrbisSnapshot {
  if (!current) return next
  if (next.scan.generation < current.scan.generation) return current
  if (next.scan.generation === current.scan.generation && next.scan.status === "scanning" && current.scan.status !== "scanning") return current
  return next
}

function ScanStatus({ snapshot, onCancel, onRescan, onOpenPermissions }: { readonly snapshot: OrbisSnapshot; readonly onCancel: () => void; readonly onRescan: () => void; readonly onOpenPermissions: () => void }): React.JSX.Element {
  const presentation = scanStatusPresentation(snapshot)
  const totals = snapshot.scan.totals
  const skippedPaths = totals ? Math.max(totals.skippedItems, totals.unreadableItems) : 0
  return <div className="orbis-feature-panel__scan-status" aria-live="polite">
    <div className="orbis-feature-panel__scan-status-copy" data-committed={snapshot.committed}><strong>{presentation.heading}</strong><span>{presentation.detail}</span></div>
    {presentation.progress ? <><Progress value={presentation.progress.value} max={100} className="orbis-feature-panel__scan-progress" aria-label={presentation.progress.label} aria-valuetext={presentation.progress.valueText} /><Button size="sm" variant="outline" onClick={onCancel}>Pause</Button></> : snapshot.scan.status === "canceled" ? <Button size="sm" onClick={onRescan}>{snapshot.scan.resume?.available ? "Resume" : "Rescan"}</Button> : null}
    {skippedPaths > 0 && <div className="orbis-feature-panel__scan-warning" role="note"><AlertCircle aria-hidden="true" /><span><strong>Some paths were skipped</strong><small>{skippedPaths.toLocaleString()} path{skippedPaths === 1 ? "" : "s"} could not be included</small></span><Button size="sm" variant="outline" onClick={onOpenPermissions}>Open Full Disk Access</Button></div>}
  </div>
}

function FolderSize({ node }: { readonly node: NodeSummary }): React.JSX.Element {
  const value = formatBytes(isPending(node) ? node.estimatedSizeBytes ?? node.sizeBytes : node.sizeBytes)
  const label = node.sizeAccuracy === "estimated" ? "Estimated size" : node.sizeAccuracy === "exact" ? "Size" : "Known size"
  const accessibleLabel = node.sizeAccuracy === "estimated" ? `Estimated folder size, ${value}` : node.sizeAccuracy === "exact" ? `Folder size, ${value}` : `Known folder size, ${value}`
  return <p className="orbis-feature-panel__folder-size" aria-label={accessibleLabel}><span>{label}</span><strong>{value}</strong></p>
}

function Breadcrumbs({ snapshot, onFocus, onContextMenu }: { readonly snapshot: OrbisSnapshot; readonly onFocus: (id: string) => void; readonly onContextMenu: (id: string) => void }): React.JSX.Element {
  return <nav className="orbis-feature-panel__breadcrumbs" aria-label="Folder breadcrumbs">{snapshot.breadcrumbs.map((breadcrumb, index) => <span key={breadcrumb.id}><button type="button" onClick={() => onFocus(breadcrumb.id)} onContextMenu={(event) => { event.preventDefault(); onContextMenu(breadcrumb.id) }} aria-current={index === snapshot.breadcrumbs.length - 1 ? "location" : undefined}>{breadcrumb.name}</button>{index < snapshot.breadcrumbs.length - 1 && <span aria-hidden="true">/</span>}</span>)}</nav>
}

function DirectoryContents({ snapshot, onActivate, onContextMenu }: { readonly snapshot: OrbisSnapshot; readonly onActivate: (item: NodeSummary) => void; readonly onContextMenu: (id: string) => void }): React.JSX.Element {
  const focus = snapshot.focus
  const name = focus?.name ?? snapshot.target.name
  const size = focus ? nodeSizePresentation(focus).visible : formatBytes(0)
  return <aside className="orbis-feature-panel__contents" aria-label={`${name} contents`}>
    <div className="orbis-feature-panel__contents-heading"><h2>{name}</h2><strong>{size}</strong></div>
    {snapshot.largestItems.length === 0 ? <p className="orbis-feature-panel__muted">No readable items in this folder.</p> : <ul className="orbis-feature-panel__contents-list" aria-label={`${name} contents`}>{snapshot.largestItems.map((item) => {
      const itemSize = nodeSizePresentation(item)
      const segment = snapshot.chart.find((candidate) => candidate.id === item.id && candidate.depth === 1)
      const color = segment ? segmentColor(segment, snapshot.chart) : item.kind === "directory" ? "#5a87c5" : "#89909a"
      return <li key={item.id}><button type="button" onClick={() => onActivate(item)} onContextMenu={(event) => { event.preventDefault(); onContextMenu(item.id) }} aria-label={`${item.name}, ${item.kind}, ${itemSize.accessible}`}><span className="orbis-feature-panel__contents-list-name"><span className="orbis-feature-panel__node-dot" style={{ backgroundColor: color }} aria-hidden="true" />{item.name}</span><span className="orbis-feature-panel__contents-list-size">{itemSize.visible}</span></button></li>
    })}</ul>}
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
