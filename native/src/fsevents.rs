use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

#[napi(object)]
pub struct VolumeCheckpoint {
    pub device: String,
    pub journal_uuid: Option<String>,
    pub event_id: String,
}

#[napi(object)]
pub struct ChangeEvent {
    pub relative_path: String,
    pub event_id: String,
    pub flags: u32,
}

#[napi(object)]
pub struct ChangeBatch {
    pub through_event_id: String,
    pub events: Vec<ChangeEvent>,
    pub requires_full_scan: bool,
    pub reason: Option<String>,
}

#[napi]
pub fn capture_volume_checkpoint(target: String) -> Result<VolumeCheckpoint> {
    #[cfg(target_os = "macos")]
    {
        let volume = macos::volume(&target)?;
        let event_id = macos::event_fence(volume.device);
        return Ok(VolumeCheckpoint {
            device: volume.device.to_string(),
            journal_uuid: macos::journal_uuid(volume.device),
            event_id: event_id.to_string(),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(Error::from_reason("FSEvents is only available on macOS"))
    }
}

#[napi]
pub fn read_changes(
    target: String,
    expected_uuid: String,
    since_id: String,
    max_events: u32,
    timeout_ms: u32,
) -> Result<ChangeBatch> {
    #[cfg(target_os = "macos")]
    {
        let since = parse_event_id(&since_id)?;
        let max_events = max_events.clamp(1, 100_000);
        let timeout_ms = timeout_ms.clamp(1, 30_000);
        if macos::begin_replay().is_err() {
            return Ok(macos::busy_fallback(since));
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result =
                macos::read_changes(&target, &expected_uuid, since, max_events, timeout_ms);
            macos::finish_replay();
            let _ = sender.send(result);
        });
        return receiver
            .recv_timeout(std::time::Duration::from_millis(timeout_ms as u64))
            .unwrap_or_else(|_| Ok(macos::timeout_fallback(since)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (target, expected_uuid, since_id, max_events, timeout_ms);
        Err(Error::from_reason("FSEvents is only available on macOS"))
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_event_id(value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .map_err(|_| Error::from_reason("invalid FSEvents cursor"))
}

#[cfg(test)]
mod cursor_tests {
    use super::parse_event_id;

    #[test]
    fn parses_the_full_unsigned_event_id_range() {
        assert_eq!(parse_event_id("0").unwrap(), 0);
        assert_eq!(parse_event_id("18446744073709551615").unwrap(), u64::MAX);
        assert!(parse_event_id("18446744073709551616").is_err());
        assert!(parse_event_id("-1").is_err());
        assert!(parse_event_id("1.5").is_err());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{ChangeBatch, ChangeEvent};
    use core_foundation_sys::array::{
        kCFTypeArrayCallBacks, CFArrayCreate, CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef,
    };
    use core_foundation_sys::base::{kCFAllocatorDefault, Boolean, CFIndex, CFRelease, CFTypeRef};
    use core_foundation_sys::runloop::{
        kCFRunLoopDefaultMode, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRunInMode, CFRunLoopStop,
    };
    use core_foundation_sys::string::{
        CFStringCreateWithFileSystemRepresentation, CFStringGetFileSystemRepresentation,
        CFStringGetMaximumSizeOfFileSystemRepresentation, CFStringRef,
    };
    use core_foundation_sys::uuid::{CFUUIDGetUUIDBytes, CFUUIDRef};
    use napi::bindgen_prelude::{Error, Result};
    use std::ffi::{c_void, CStr, CString};
    use std::fs;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const CREATE_USE_CF_TYPES: u32 = 0x0000_0001;
    const CREATE_WATCH_ROOT: u32 = 0x0000_0004;
    const CREATE_FILE_EVENTS: u32 = 0x0000_0010;
    const CREATE_FULL_HISTORY: u32 = 0x0000_0080;

    #[cfg(test)]
    const EVENT_MUST_SCAN_SUBDIRS: u32 = 0x0000_0001;
    const EVENT_USER_DROPPED: u32 = 0x0000_0002;
    const EVENT_KERNEL_DROPPED: u32 = 0x0000_0004;
    const EVENT_IDS_WRAPPED: u32 = 0x0000_0008;
    const EVENT_HISTORY_DONE: u32 = 0x0000_0010;
    const EVENT_ROOT_CHANGED: u32 = 0x0000_0020;
    const EVENT_MOUNT: u32 = 0x0000_0040;
    const EVENT_UNMOUNT: u32 = 0x0000_0080;
    static REPLAY_ACTIVE: AtomicBool = AtomicBool::new(false);

    type FSEventStreamRef = *mut c_void;
    type FSEventStreamCallback = unsafe extern "C" fn(
        FSEventStreamRef,
        *mut c_void,
        usize,
        *mut c_void,
        *const u32,
        *const u64,
    );

    #[repr(C)]
    struct FSEventStreamContext {
        version: CFIndex,
        info: *mut c_void,
        retain: *const c_void,
        release: *const c_void,
        copy_description: *const c_void,
    }

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn FSEventsCopyUUIDForDevice(device: libc::dev_t) -> CFUUIDRef;
        fn FSEventsGetLastEventIdForDeviceBeforeTime(device: libc::dev_t, time: f64) -> u64;
        fn FSEventStreamCreateRelativeToDevice(
            allocator: *const c_void,
            callback: FSEventStreamCallback,
            context: *mut FSEventStreamContext,
            device: libc::dev_t,
            paths: CFArrayRef,
            since_when: u64,
            latency: f64,
            flags: u32,
        ) -> FSEventStreamRef;
        fn FSEventStreamScheduleWithRunLoop(
            stream: FSEventStreamRef,
            run_loop: CFRunLoopRef,
            mode: CFStringRef,
        );
        fn FSEventStreamUnscheduleFromRunLoop(
            stream: FSEventStreamRef,
            run_loop: CFRunLoopRef,
            mode: CFStringRef,
        );
        fn FSEventStreamStart(stream: FSEventStreamRef) -> Boolean;
        fn FSEventStreamGetLatestEventId(stream: FSEventStreamRef) -> u64;
        fn FSEventStreamFlushSync(stream: FSEventStreamRef);
        fn FSEventStreamStop(stream: FSEventStreamRef);
        fn FSEventStreamInvalidate(stream: FSEventStreamRef);
        fn FSEventStreamRelease(stream: FSEventStreamRef);
    }

    pub(super) struct Volume {
        pub device: libc::dev_t,
        relative_target: String,
    }

    pub(super) fn volume(target: &str) -> Result<Volume> {
        let requested = Path::new(target);
        let requested_metadata = fs::symlink_metadata(requested).map_err(io_error)?;
        if requested_metadata.file_type().is_symlink() || !requested_metadata.is_dir() {
            return Err(Error::from_reason("FSEvents target must be a directory"));
        }
        let canonical = fs::canonicalize(requested).map_err(io_error)?;
        let metadata = fs::metadata(&canonical).map_err(io_error)?;
        let device = metadata.dev() as libc::dev_t;
        let root = volume_root(&canonical, metadata.dev())?;
        let relative = canonical
            .strip_prefix(&root)
            .map_err(|_| Error::from_reason("cannot resolve volume-relative FSEvents target"))?;
        let relative_target = relative
            .to_str()
            .ok_or_else(|| Error::from_reason("FSEvents target is not valid UTF-8"))?
            .trim_matches('/')
            .to_owned();
        Ok(Volume {
            device,
            relative_target,
        })
    }

    fn volume_root(path: &Path, device: u64) -> Result<PathBuf> {
        let mut root = path.to_path_buf();
        while let Some(parent) = root.parent() {
            match fs::metadata(parent) {
                Ok(metadata) if metadata.dev() == device => root = parent.to_path_buf(),
                Ok(_) => break,
                Err(error) => return Err(io_error(error)),
            }
        }
        Ok(root)
    }

    pub(super) fn event_fence(device: libc::dev_t) -> u64 {
        // Despite the CFAbsoluteTime typedef, the per-device FSEvents store is
        // timestamped against the Unix epoch on supported macOS releases.
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        unsafe { FSEventsGetLastEventIdForDeviceBeforeTime(device, seconds) }
    }

    pub(super) fn journal_uuid(device: libc::dev_t) -> Option<String> {
        unsafe {
            let uuid = FSEventsCopyUUIDForDevice(device);
            if uuid.is_null() {
                return None;
            }
            let bytes = CFUUIDGetUUIDBytes(uuid);
            CFRelease(uuid as CFTypeRef);
            Some(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes.byte0, bytes.byte1, bytes.byte2, bytes.byte3, bytes.byte4, bytes.byte5, bytes.byte6, bytes.byte7,
        bytes.byte8, bytes.byte9, bytes.byte10, bytes.byte11, bytes.byte12, bytes.byte13, bytes.byte14, bytes.byte15
      ))
        }
    }

    pub(super) fn read_changes(
        target: &str,
        expected_uuid: &str,
        since: u64,
        max_events: u32,
        timeout_ms: u32,
    ) -> Result<ChangeBatch> {
        let volume = volume(target)?;
        let Some(actual_uuid) = journal_uuid(volume.device) else {
            return Ok(fallback(since, "history-unavailable"));
        };
        if actual_uuid != expected_uuid {
            return Ok(fallback(since, "journal-uuid-changed"));
        }
        // A cursor produced by a flushed per-device stream can briefly exceed
        // the wall-clock device fence. Keep it as the lower publication bound
        // and let FSEvents validate history through the stream flags.
        let through = event_fence(volume.device).max(since);
        let watched = create_cf_string(&volume.relative_target)?;
        let values = [watched as *const c_void];
        let paths = unsafe {
            CFArrayCreate(
                kCFAllocatorDefault,
                values.as_ptr(),
                1,
                &kCFTypeArrayCallBacks,
            )
        };
        unsafe { CFRelease(watched as CFTypeRef) };
        if paths.is_null() {
            return Err(Error::from_reason("cannot create FSEvents watch path"));
        }

        let run_loop = unsafe { CFRunLoopGetCurrent() };
        let mut collector = Box::new(Collector {
            watch_relative: volume.relative_target,
            since,
            through: u64::MAX,
            max_seen: since,
            max_events: max_events as usize,
            events: Vec::new(),
            history_done: false,
            requires_full_scan: false,
            reason: None,
            run_loop,
        });
        let mut context = FSEventStreamContext {
            version: 0,
            info: (&mut *collector as *mut Collector).cast(),
            retain: ptr::null(),
            release: ptr::null(),
            copy_description: ptr::null(),
        };
        let flags =
            CREATE_USE_CF_TYPES | CREATE_WATCH_ROOT | CREATE_FILE_EVENTS | CREATE_FULL_HISTORY;
        let stream = unsafe {
            FSEventStreamCreateRelativeToDevice(
                kCFAllocatorDefault,
                collect_events,
                &mut context,
                volume.device,
                paths,
                since,
                0.05,
                flags,
            )
        };
        unsafe { CFRelease(paths as CFTypeRef) };
        if stream.is_null() {
            return Ok(fallback(since, "history-unavailable"));
        }

        unsafe { FSEventStreamScheduleWithRunLoop(stream, run_loop, kCFRunLoopDefaultMode) };
        let started = unsafe { FSEventStreamStart(stream) } != 0;
        let mut flush_fence = None;
        if started {
            unsafe { FSEventStreamFlushSync(stream) };
            flush_fence = Some(unsafe { FSEventStreamGetLatestEventId(stream) });
            let now = Instant::now();
            let deadline = now + Duration::from_millis(timeout_ms as u64);
            let quiet_deadline = now + Duration::from_millis((timeout_ms as u64).min(100));
            loop {
                if collector.history_done
                    && (flush_fence.unwrap_or(since) > since || Instant::now() >= quiet_deadline)
                {
                    break;
                }
                if collector.reason.as_deref() == Some("event-limit") {
                    break;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    collector.requires_full_scan = true;
                    collector.reason = Some("history-timeout".to_owned());
                    break;
                }
                let seconds = remaining.as_secs_f64().min(0.05);
                unsafe {
                    CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, 1);
                    FSEventStreamFlushSync(stream);
                    flush_fence = Some(FSEventStreamGetLatestEventId(stream));
                }
            }
        } else {
            collector.requires_full_scan = true;
            collector.reason = Some("history-unavailable".to_owned());
        }

        unsafe {
            FSEventStreamStop(stream);
            FSEventStreamUnscheduleFromRunLoop(stream, run_loop, kCFRunLoopDefaultMode);
            FSEventStreamInvalidate(stream);
            FSEventStreamRelease(stream);
        }
        if !collector.history_done && collector.reason.is_none() {
            collector.requires_full_scan = true;
            collector.reason = Some("history-incomplete".to_owned());
        }
        let through = through.max(flush_fence.unwrap_or(0));
        collector
            .events
            .retain(|event| event.event_id.parse::<u64>().is_ok_and(|id| id <= through));
        Ok(ChangeBatch {
            through_event_id: if collector.requires_full_scan {
                since
            } else {
                through
            }
            .to_string(),
            events: if collector.requires_full_scan {
                Vec::new()
            } else {
                std::mem::take(&mut collector.events)
            },
            requires_full_scan: collector.requires_full_scan,
            reason: collector.reason.take(),
        })
    }

    unsafe extern "C" fn collect_events(
        _stream: FSEventStreamRef,
        info: *mut c_void,
        count: usize,
        paths: *mut c_void,
        flags: *const u32,
        ids: *const u64,
    ) {
        if info.is_null() || paths.is_null() || flags.is_null() || ids.is_null() {
            return;
        }
        let collector = &mut *(info as *mut Collector);
        let paths = paths as CFArrayRef;
        let available = CFArrayGetCount(paths).max(0) as usize;
        for index in 0..count.min(available) {
            let flag = *flags.add(index);
            let event_id = *ids.add(index);
            collector.max_seen = collector.max_seen.max(event_id);
            if let Some(reason) = fallback_reason(flag) {
                collector.requires_full_scan = true;
                collector.reason = Some(reason.to_owned());
            }
            if flag & EVENT_HISTORY_DONE != 0 {
                collector.history_done = true;
                continue;
            }
            if event_id <= collector.since || event_id > collector.through {
                continue;
            }
            let value = CFArrayGetValueAtIndex(paths, index as CFIndex) as CFStringRef;
            let Some(device_relative) = cf_string(value) else {
                collector.requires_full_scan = true;
                collector.reason = Some("malformed-history".to_owned());
                continue;
            };
            let Some(relative_path) = target_relative(&device_relative, &collector.watch_relative)
            else {
                collector.requires_full_scan = true;
                collector.reason = Some("malformed-history".to_owned());
                continue;
            };
            if collector.events.len() >= collector.max_events {
                collector.requires_full_scan = true;
                collector.reason = Some("event-limit".to_owned());
                CFRunLoopStop(collector.run_loop);
                break;
            }
            collector.events.push(ChangeEvent {
                relative_path,
                event_id: event_id.to_string(),
                flags: flag,
            });
        }
    }

    struct Collector {
        watch_relative: String,
        since: u64,
        through: u64,
        max_seen: u64,
        max_events: usize,
        events: Vec<ChangeEvent>,
        history_done: bool,
        requires_full_scan: bool,
        reason: Option<String>,
        run_loop: CFRunLoopRef,
    }

    pub(super) fn begin_replay() -> std::result::Result<(), ()> {
        REPLAY_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| ())
    }

    pub(super) fn finish_replay() {
        REPLAY_ACTIVE.store(false, Ordering::Release);
    }

    pub(super) fn busy_fallback(since: u64) -> ChangeBatch {
        fallback(since, "history-busy")
    }

    pub(super) fn timeout_fallback(since: u64) -> ChangeBatch {
        fallback(since, "history-timeout")
    }

    fn fallback(since: u64, reason: &str) -> ChangeBatch {
        ChangeBatch {
            through_event_id: since.to_string(),
            events: Vec::new(),
            requires_full_scan: true,
            reason: Some(reason.to_owned()),
        }
    }

    fn fallback_reason(flags: u32) -> Option<&'static str> {
        if flags & EVENT_USER_DROPPED != 0 {
            Some("user-dropped")
        } else if flags & EVENT_KERNEL_DROPPED != 0 {
            Some("kernel-dropped")
        } else if flags & EVENT_IDS_WRAPPED != 0 {
            Some("event-ids-wrapped")
        } else if flags & EVENT_ROOT_CHANGED != 0 {
            Some("root-changed")
        } else if flags & (EVENT_MOUNT | EVENT_UNMOUNT) != 0 {
            Some("mount-changed")
        } else {
            None
        }
    }

    fn target_relative(device_path: &str, watch_relative: &str) -> Option<String> {
        let path = device_path.trim_start_matches('/').trim_end_matches('/');
        let watch = watch_relative.trim_matches('/');
        if watch.is_empty() {
            return Some(path.to_owned());
        }
        if path == watch {
            return Some(String::new());
        }
        path.strip_prefix(watch)?
            .strip_prefix('/')
            .map(str::to_owned)
    }

    fn create_cf_string(value: &str) -> Result<CFStringRef> {
        let c_string = CString::new(value.as_bytes())
            .map_err(|_| Error::from_reason("invalid FSEvents path"))?;
        let string = unsafe {
            CFStringCreateWithFileSystemRepresentation(kCFAllocatorDefault, c_string.as_ptr())
        };
        if string.is_null() {
            Err(Error::from_reason("cannot create FSEvents path"))
        } else {
            Ok(string)
        }
    }

    unsafe fn cf_string(value: CFStringRef) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let capacity = CFStringGetMaximumSizeOfFileSystemRepresentation(value);
        if capacity < 0 {
            return None;
        }
        let mut buffer = vec![0_i8; capacity as usize + 1];
        if CFStringGetFileSystemRepresentation(value, buffer.as_mut_ptr(), buffer.len() as CFIndex)
            == 0
        {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr())
            .to_str()
            .ok()
            .map(str::to_owned)
    }

    fn io_error(error: std::io::Error) -> Error {
        Error::from_reason(error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_device_paths_to_the_watched_target() {
            assert_eq!(
                target_relative("Users/mac/file", "Users/mac"),
                Some("file".to_owned())
            );
            assert_eq!(
                target_relative("/Users/mac", "Users/mac"),
                Some(String::new())
            );
            assert_eq!(target_relative("Users/other", "Users/mac"), None);
            assert_eq!(
                target_relative("folder/file", ""),
                Some("folder/file".to_owned())
            );
        }

        #[test]
        fn bounds_concurrent_replay_threads() {
            assert!(begin_replay().is_ok());
            assert!(begin_replay().is_err());
            finish_replay();
            assert!(begin_replay().is_ok());
            finish_replay();
        }

        #[test]
        fn classifies_history_failures() {
            assert_eq!(
                fallback_reason(EVENT_USER_DROPPED | EVENT_MUST_SCAN_SUBDIRS),
                Some("user-dropped")
            );
            assert_eq!(
                fallback_reason(EVENT_KERNEL_DROPPED),
                Some("kernel-dropped")
            );
            assert_eq!(
                fallback_reason(EVENT_IDS_WRAPPED),
                Some("event-ids-wrapped")
            );
            assert_eq!(fallback_reason(EVENT_ROOT_CHANGED), Some("root-changed"));
            assert_eq!(fallback_reason(EVENT_MOUNT), Some("mount-changed"));
            assert_eq!(fallback_reason(EVENT_MUST_SCAN_SUBDIRS), None);
        }
    }
}
