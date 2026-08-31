#![deny(clippy::all)]

mod fsevents;
pub use fsevents::{capture_volume_checkpoint, read_changes};

use napi::bindgen_prelude::{AsyncTask, Buffer, Error, Result, Task};
use napi_derive::napi;
use std::collections::{HashSet, VecDeque};
#[cfg(target_os = "macos")]
use std::ffi::CString;
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "macos")]
use std::os::unix::fs::MetadataExt;
#[cfg(target_os = "macos")]
use std::os::unix::io::{AsRawFd, FromRawFd};
#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc, Mutex,
};
#[cfg(target_os = "macos")]
use std::time::Instant;

// Not exposed by the libc crate; from <sys/attr.h> (ATTR_CMN_ERROR 0x20000000).
#[cfg(target_os = "macos")]
const ATTR_CMN_ERROR: u32 = 0x2000_0000;

#[derive(Clone)]
pub struct MetadataEntry {
    pub name: String,
    pub kind: String,
    pub device: String,
    pub inode: String,
    pub allocated_bytes: i64,
    pub link_count: i64,
    pub mount_point: bool,
    pub error_code: Option<i32>,
}

pub struct MetadataPage {
    pub entries: Vec<MetadataEntry>,
    pub done: bool,
    pub bulk_entries: i64,
    pub fallback_entries: i64,
}

#[napi(object)]
pub struct PackedMetadataPage {
    pub payload: Buffer,
    pub count: u32,
    pub done: bool,
    pub bulk_entries: i64,
    pub fallback_entries: i64,
}

pub struct ReadPageOutput {
    payload: Vec<u8>,
    count: u32,
    done: bool,
    bulk_entries: i64,
    fallback_entries: i64,
}

#[napi(object)]
pub struct NativeScanSummary {
    pub elapsed_ms: f64,
    pub scanned_items: i64,
    pub files: i64,
    pub directories: i64,
    pub allocated_bytes: i64,
    pub skipped_items: i64,
    pub unreadable_items: i64,
    pub nested_mounts: i64,
    pub symlinks: i64,
    pub duplicate_hard_links: i64,
    pub bulk_calls: i64,
}

pub struct NativeScanTask {
    target: String,
}

impl Task for NativeScanTask {
    type Output = NativeScanSummary;
    type JsValue = NativeScanSummary;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            scan_tree_summary_impl(&self.target)
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(Error::from_reason(
                "native tree scanning is only available on macOS",
            ))
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn scan_tree_summary(target: String) -> AsyncTask<NativeScanTask> {
    AsyncTask::new(NativeScanTask { target })
}

#[napi(object)]
pub struct NativeDatabaseScanProgress {
    pub scanned_items: i64,
    pub allocated_bytes: i64,
    pub indexing: bool,
}

struct NativeDatabaseProgressState {
    scanned_items: AtomicI64,
    allocated_bytes: AtomicI64,
    indexing: AtomicBool,
}

impl NativeDatabaseProgressState {
    fn reset(&self) {
        self.scanned_items.store(0, Ordering::Relaxed);
        self.allocated_bytes.store(0, Ordering::Relaxed);
        self.indexing.store(false, Ordering::Release);
    }

    fn add(&self, items: i64, allocated_bytes: i64) {
        self.scanned_items.fetch_add(items, Ordering::Relaxed);
        self.allocated_bytes
            .fetch_add(allocated_bytes, Ordering::Relaxed);
    }

    fn snapshot(&self) -> NativeDatabaseScanProgress {
        NativeDatabaseScanProgress {
            scanned_items: self.scanned_items.load(Ordering::Relaxed),
            allocated_bytes: self.allocated_bytes.load(Ordering::Relaxed),
            indexing: self.indexing.load(Ordering::Acquire),
        }
    }
}

#[napi(object)]
pub struct NativeDatabaseScanSummary {
    pub elapsed_ms: f64,
    pub traversal_ms: f64,
    pub index_ms: f64,
    pub scanned_items: i64,
    pub files: i64,
    pub directories: i64,
    pub allocated_bytes: i64,
    pub skipped_items: i64,
    pub unreadable_items: i64,
    pub nested_mounts: i64,
    pub symlinks: i64,
    pub duplicate_hard_links: i64,
}

pub struct NativeDatabaseScanTask {
    target: String,
    database_path: String,
    cancellation: Arc<AtomicBool>,
    progress: Arc<NativeDatabaseProgressState>,
}

#[napi]
pub struct NativeDatabaseScanner {
    cancellation: Arc<AtomicBool>,
    progress: Arc<NativeDatabaseProgressState>,
}

#[napi]
impl NativeDatabaseScanner {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancellation: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(NativeDatabaseProgressState {
                scanned_items: AtomicI64::new(0),
                allocated_bytes: AtomicI64::new(0),
                indexing: AtomicBool::new(false),
            }),
        }
    }

    #[napi]
    pub fn scan_tree_to_database(
        &self,
        target: String,
        database_path: String,
    ) -> AsyncTask<NativeDatabaseScanTask> {
        self.cancellation.store(false, Ordering::Relaxed);
        self.progress.reset();
        AsyncTask::new(NativeDatabaseScanTask {
            target,
            database_path,
            cancellation: self.cancellation.clone(),
            progress: self.progress.clone(),
        })
    }

    #[napi]
    pub fn progress(&self) -> NativeDatabaseScanProgress {
        self.progress.snapshot()
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancellation.store(true, Ordering::Relaxed);
    }
}

impl Task for NativeDatabaseScanTask {
    type Output = NativeDatabaseScanSummary;
    type JsValue = NativeDatabaseScanSummary;
    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            scan_tree_to_database_impl(
                &self.target,
                &self.database_path,
                &self.cancellation,
                &self.progress,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(Error::from_reason(
                "native tree scanning is only available on macOS",
            ))
        }
    }
    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn scan_tree_to_database(
    target: String,
    database_path: String,
) -> AsyncTask<NativeDatabaseScanTask> {
    AsyncTask::new(NativeDatabaseScanTask {
        target,
        database_path,
        cancellation: Arc::new(AtomicBool::new(false)),
        progress: Arc::new(NativeDatabaseProgressState {
            scanned_items: AtomicI64::new(0),
            allocated_bytes: AtomicI64::new(0),
            indexing: AtomicBool::new(false),
        }),
    })
}

#[napi]
pub struct MetadataTree {
    #[cfg(target_os = "macos")]
    root: Arc<Mutex<Option<File>>>,
}

#[napi]
pub struct DirectoryCursor {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<CursorState>>,
}

#[cfg(target_os = "macos")]
struct CursorState {
    parent_device: u64,
    file: Option<File>,
    pending_bulk: VecDeque<MetadataEntry>,
    bulk_done: bool,
    closed: bool,
}

pub struct ReadPageTask {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<CursorState>>,
    limit: usize,
}

impl Task for ReadPageTask {
    type Output = ReadPageOutput;
    type JsValue = PackedMetadataPage;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("metadata cursor lock poisoned"))?;
            let page = read_page_from_state(&mut state, self.limit)?;
            let count = page.entries.len() as u32;
            Ok(ReadPageOutput {
                payload: encode_metadata_page(&page.entries),
                count,
                done: page.done,
                bulk_entries: page.bulk_entries,
                fallback_entries: page.fallback_entries,
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = self.limit;
            Err(Error::from_reason(
                "getattrlistbulk is only available on macOS",
            ))
        }
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(PackedMetadataPage {
            payload: output.payload.into(),
            count: output.count,
            done: output.done,
            bulk_entries: output.bulk_entries,
            fallback_entries: output.fallback_entries,
        })
    }
}

#[napi]
impl DirectoryCursor {
    #[napi]
    pub fn read_page(&self, limit: u32) -> AsyncTask<ReadPageTask> {
        #[cfg(target_os = "macos")]
        {
            AsyncTask::new(ReadPageTask {
                inner: self.inner.clone(),
                limit: clamp_page_limit(limit),
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (self, limit);
            AsyncTask::new(ReadPageTask { limit: 0 })
        }
    }

    #[napi]
    pub fn close(&self) {
        #[cfg(target_os = "macos")]
        if let Ok(mut state) = self.inner.lock() {
            state.closed = true;
            state.file.take();
        }
    }
}

#[napi]
impl MetadataTree {
    #[napi]
    pub fn open_directory(&self, relative_path: String) -> Result<DirectoryCursor> {
        #[cfg(target_os = "macos")]
        {
            validate_relative_path(&relative_path)?;
            let root = self
                .root
                .lock()
                .map_err(|_| Error::from_reason("metadata tree lock poisoned"))?;
            let root = root
                .as_ref()
                .ok_or_else(|| Error::from_reason("metadata tree is closed"))?;
            let duplicated = unsafe { libc::dup(root.as_raw_fd()) };
            if duplicated < 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            let mut file = unsafe { File::from_raw_fd(duplicated) };
            for component in relative_path
                .split('/')
                .filter(|component| !component.is_empty())
            {
                let name = CString::new(component.as_bytes())
                    .map_err(|_| Error::from_reason("metadata path contains NUL"))?;
                let descriptor = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if descriptor < 0 {
                    return Err(io_error(std::io::Error::last_os_error()));
                }
                file = unsafe { File::from_raw_fd(descriptor) };
            }
            return cursor_from_file(file);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = relative_path;
            Err(Error::from_reason(
                "getattrlistbulk is only available on macOS",
            ))
        }
    }

    #[napi]
    pub fn close(&self) {
        #[cfg(target_os = "macos")]
        if let Ok(mut root) = self.root.lock() {
            root.take();
        }
    }
}

#[napi]
pub fn open_metadata_tree(target: String) -> Result<MetadataTree> {
    #[cfg(target_os = "macos")]
    {
        let path = CString::new(Path::new(&target).as_os_str().as_bytes())
            .map_err(|_| Error::from_reason("metadata target contains NUL"))?;
        let descriptor = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if descriptor < 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        let file = unsafe { File::from_raw_fd(descriptor) };
        return Ok(MetadataTree {
            root: Arc::new(Mutex::new(Some(file))),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err(Error::from_reason(
            "getattrlistbulk is only available on macOS",
        ))
    }
}

#[cfg(target_os = "macos")]
fn validate_relative_path(path: &str) -> Result<()> {
    if path.starts_with('/')
        || path.as_bytes().contains(&0)
        || path
            .split('/')
            .any(|part| part.is_empty() && !path.is_empty() || part == "." || part == "..")
    {
        return Err(Error::from_reason("invalid relative metadata path"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn cursor_from_file(file: File) -> Result<DirectoryCursor> {
    use std::mem::MaybeUninit;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let stat = unsafe { stat.assume_init() };
    Ok(DirectoryCursor {
        inner: Arc::new(Mutex::new(CursorState {
            parent_device: stat.st_dev as u64,
            file: Some(file),
            pending_bulk: VecDeque::new(),
            bulk_done: false,
            closed: false,
        })),
    })
}

fn encode_metadata_page(entries: &[MetadataEntry]) -> Vec<u8> {
    const HEADER_SIZE: usize = 16;
    const RECORD_SIZE: usize = 48;
    let name_bytes = entries
        .iter()
        .map(|entry| entry.name.as_bytes().len())
        .sum::<usize>();
    let mut output = vec![0u8; HEADER_SIZE + RECORD_SIZE * entries.len() + name_bytes];
    output[0..4].copy_from_slice(b"ORB1");
    output[4..6].copy_from_slice(&1u16.to_le_bytes());
    output[6..8].copy_from_slice(&(RECORD_SIZE as u16).to_le_bytes());
    output[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
    output[12..16].copy_from_slice(&(name_bytes as u32).to_le_bytes());
    let mut name_offset = 0usize;
    for (index, entry) in entries.iter().enumerate() {
        let record = HEADER_SIZE + index * RECORD_SIZE;
        let name = entry.name.as_bytes();
        output[record..record + 4].copy_from_slice(&(name_offset as u32).to_le_bytes());
        output[record + 4..record + 8].copy_from_slice(&(name.len() as u32).to_le_bytes());
        output[record + 8] = match entry.kind.as_str() {
            "file" => 1,
            "directory" => 2,
            "symlink" => 3,
            _ => 0,
        };
        let device = entry.device.parse::<u64>().ok();
        let inode = entry.inode.parse::<u64>().ok();
        let link_count = u64::try_from(entry.link_count).ok();
        let mut flags = if entry.mount_point { 1 } else { 0 };
        if device.is_some() {
            flags |= 1 << 1;
        }
        if inode.is_some() {
            flags |= 1 << 2;
        }
        if link_count.is_some() {
            flags |= 1 << 3;
        }
        if entry.error_code.is_some() {
            flags |= 1 << 4;
        }
        output[record + 9] = flags;
        output[record + 12..record + 16]
            .copy_from_slice(&entry.error_code.unwrap_or(0).to_le_bytes());
        output[record + 16..record + 24].copy_from_slice(&device.unwrap_or(0).to_le_bytes());
        output[record + 24..record + 32].copy_from_slice(&inode.unwrap_or(0).to_le_bytes());
        output[record + 32..record + 40]
            .copy_from_slice(&(entry.allocated_bytes.max(0) as u64).to_le_bytes());
        output[record + 40..record + 48].copy_from_slice(&link_count.unwrap_or(0).to_le_bytes());
        let blob = HEADER_SIZE + RECORD_SIZE * entries.len() + name_offset;
        output[blob..blob + name.len()].copy_from_slice(name);
        name_offset += name.len();
    }
    output
}

fn clamp_page_limit(limit: u32) -> usize {
    limit.clamp(1, 1_024) as usize
}

#[cfg(target_os = "macos")]
fn read_page_from_state(state: &mut CursorState, safe_limit: usize) -> Result<MetadataPage> {
    if state.closed {
        return Ok(empty_page(true));
    }
    let file = state
        .file
        .as_ref()
        .ok_or_else(|| Error::from_reason("metadata cursor is closed"))?;
    let (entries, bulk_error) = fill_requested_entries(
        &mut state.pending_bulk,
        &mut state.bulk_done,
        safe_limit,
        || read_bulk_records(file.as_raw_fd(), state.parent_device),
    );
    if let Some(error) = bulk_error {
        return Err(error);
    }
    let bulk_entries = entries.len();
    let done = state.bulk_done && state.pending_bulk.is_empty();
    Ok(MetadataPage {
        bulk_entries: bulk_entries as i64,
        fallback_entries: 0,
        entries,
        done,
    })
}

fn fill_requested_entries<E>(
    pending: &mut VecDeque<MetadataEntry>,
    done: &mut bool,
    limit: usize,
    mut refill: impl FnMut() -> std::result::Result<Vec<MetadataEntry>, E>,
) -> (Vec<MetadataEntry>, Option<E>) {
    let mut entries = Vec::with_capacity(limit);
    while entries.len() < limit {
        if let Some(entry) = pending.pop_front() {
            entries.push(entry);
            continue;
        }
        if *done {
            break;
        }
        match refill() {
            Ok(chunk) if chunk.is_empty() => *done = true,
            Ok(chunk) => pending.extend(chunk),
            Err(error) => return (entries, Some(error)),
        }
    }
    (entries, None)
}

fn empty_page(done: bool) -> MetadataPage {
    MetadataPage {
        entries: Vec::new(),
        done,
        bulk_entries: 0,
        fallback_entries: 0,
    }
}

#[cfg(target_os = "macos")]
fn read_bulk_records(
    fd: std::os::unix::io::RawFd,
    parent_device: u64,
) -> Result<Vec<MetadataEntry>> {
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS
            | libc::ATTR_CMN_NAME
            | libc::ATTR_CMN_DEVID
            | libc::ATTR_CMN_OBJTYPE
            | libc::ATTR_CMN_FILEID
            | ATTR_CMN_ERROR,
        volattr: 0,
        dirattr: libc::ATTR_DIR_ALLOCSIZE,
        fileattr: libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
        forkattr: 0,
    };
    let mut buffer = vec![0_u8; 256 * 1024];
    let count = unsafe {
        libc::getattrlistbulk(
            fd,
            &mut attributes as *mut libc::attrlist as *mut libc::c_void,
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len(),
            0,
        )
    };
    if count < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    parse_bulk_records(&buffer, count as usize, parent_device)
}

// Every bulk record starts with its u32 length and attribute_set_t (five u32s),
// followed by the requested attributes in attrlist order: ATTR_CMN_ERROR (when
// present, right after the attribute set), then NAME, DEVID, OBJTYPE, FILEID,
// then the dir attributes, then the file attributes. Only attributes whose bits
// are set in the returned bitmap are present, so the walk consumes exactly the
// bits the kernel reports. Name data lives after the fixed section and is
// addressed by the attrreference (offset relative to the reference field).
#[cfg(target_os = "macos")]
fn parse_bulk_records(
    buffer: &[u8],
    count: usize,
    parent_device: u64,
) -> Result<Vec<MetadataEntry>> {
    use std::os::unix::ffi::OsStringExt;
    let mut entries = Vec::with_capacity(count);
    let mut offset = 0_usize;
    for _ in 0..count {
        if offset.checked_add(32).is_none_or(|end| end > buffer.len()) {
            return Err(Error::from_reason(
                "getattrlistbulk returned a truncated record",
            ));
        }
        let record_length =
            u32::from_ne_bytes(buffer[offset..offset + 4].try_into().unwrap()) as usize;
        let Some(record_end) = offset.checked_add(record_length) else {
            return Err(Error::from_reason(
                "getattrlistbulk returned an invalid record length",
            ));
        };
        if record_length < 32 || record_end > buffer.len() {
            return Err(Error::from_reason(
                "getattrlistbulk returned an invalid record length",
            ));
        }
        let commonattr = u32::from_ne_bytes(buffer[offset + 4..offset + 8].try_into().unwrap());
        let dirattr = u32::from_ne_bytes(buffer[offset + 12..offset + 16].try_into().unwrap());
        let fileattr = u32::from_ne_bytes(buffer[offset + 16..offset + 20].try_into().unwrap());

        let mut cursor = offset + 24;
        let mut error_code: Option<i32> = None;
        if commonattr & ATTR_CMN_ERROR != 0 {
            if cursor + 4 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated error record",
                ));
            }
            error_code =
                Some(u32::from_ne_bytes(buffer[cursor..cursor + 4].try_into().unwrap()) as i32);
            cursor += 4;
        }

        let mut name: Option<String> = None;
        if commonattr & libc::ATTR_CMN_NAME != 0 {
            if cursor + 8 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated name reference",
                ));
            }
            let reference_offset =
                i32::from_ne_bytes(buffer[cursor..cursor + 4].try_into().unwrap());
            let reference_length =
                u32::from_ne_bytes(buffer[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
            let data_start = usize::try_from(reference_offset)
                .ok()
                .and_then(|relative| cursor.checked_add(relative));
            let data_end = data_start.and_then(|start| start.checked_add(reference_length));
            if reference_offset < 0
                || data_start.is_none_or(|start| start < cursor + 8 || start >= record_end)
                || reference_length == 0
                || data_end.is_none_or(|end| end > record_end)
            {
                if error_code.is_some() {
                    // Degenerate error record: skip it rather than fail the directory.
                    offset = record_end;
                    continue;
                }
                return Err(Error::from_reason(
                    "getattrlistbulk returned an invalid name reference",
                ));
            }
            let bytes = &buffer[data_start.unwrap()..data_end.unwrap()];
            let end = bytes
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(bytes.len());
            let parsed = std::ffi::OsString::from_vec(bytes[..end].to_vec())
                .to_string_lossy()
                .into_owned();
            if parsed.is_empty() || parsed == "." || parsed == ".." {
                if error_code.is_some() {
                    offset = record_end;
                    continue;
                }
                return Err(Error::from_reason(
                    "getattrlistbulk returned an invalid entry name",
                ));
            }
            name = Some(parsed);
            cursor += 8;
        }

        let mut device = String::new();
        let mut devid: u32 = 0;
        if commonattr & libc::ATTR_CMN_DEVID != 0 {
            if cursor + 4 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated device record",
                ));
            }
            devid = u32::from_ne_bytes(buffer[cursor..cursor + 4].try_into().unwrap());
            device = devid.to_string();
            cursor += 4;
        }

        let mut vtype: u32 = 0;
        if commonattr & libc::ATTR_CMN_OBJTYPE != 0 {
            if cursor + 4 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated object type record",
                ));
            }
            vtype = u32::from_ne_bytes(buffer[cursor..cursor + 4].try_into().unwrap());
            cursor += 4;
        }

        let mut fileid: u64 = 0;
        if commonattr & libc::ATTR_CMN_FILEID != 0 {
            if cursor + 8 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated file id record",
                ));
            }
            fileid = u64::from_ne_bytes(buffer[cursor..cursor + 8].try_into().unwrap());
            cursor += 8;
        }

        let mut dir_allocsize: u64 = 0;
        if dirattr & libc::ATTR_DIR_ALLOCSIZE != 0 {
            if cursor + 8 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated directory allocation record",
                ));
            }
            dir_allocsize = u64::from_ne_bytes(buffer[cursor..cursor + 8].try_into().unwrap());
            cursor += 8;
        }

        let mut link_count: i64 = 1;
        if fileattr & libc::ATTR_FILE_LINKCOUNT != 0 {
            if cursor + 4 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated link count record",
                ));
            }
            link_count = u32::from_ne_bytes(buffer[cursor..cursor + 4].try_into().unwrap()) as i64;
            cursor += 4;
        }

        let mut allocsize: u64 = 0;
        if fileattr & libc::ATTR_FILE_ALLOCSIZE != 0 {
            if cursor + 8 > record_end {
                return Err(Error::from_reason(
                    "getattrlistbulk returned a truncated allocation record",
                ));
            }
            allocsize = u64::from_ne_bytes(buffer[cursor..cursor + 8].try_into().unwrap());
        }

        let Some(name) = name else {
            if error_code.is_some() {
                offset = record_end;
                continue;
            }
            return Err(Error::from_reason(
                "getattrlistbulk returned a record without a name",
            ));
        };

        let kind = match vtype {
            1 => "file",      // VREG
            2 => "directory", // VDIR
            5 => "symlink",   // VLNK
            _ => "other",
        };
        entries.push(MetadataEntry {
            name,
            kind: kind.to_owned(),
            device,
            inode: if fileid == 0 {
                String::new()
            } else {
                fileid.to_string()
            },
            allocated_bytes: (allocsize.max(dir_allocsize) as i128).min(i64::MAX as i128) as i64,
            link_count,
            mount_point: kind == "directory" && devid as u64 != parent_device,
            error_code,
        });
        offset = record_end;
    }
    Ok(entries)
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
struct IndexRecord {
    id: String,
    parent: Option<String>,
    name: String,
    path: String,
    kind: &'static str,
    own: i64,
    size: i64,
    device: String,
    inode: String,
    links: i64,
    own_unreadable: i64,
    direct_children: i64,
    descendants: i64,
    unreadable: i64,
    skipped: i64,
    direct_unreadable: i64,
    symlinks: i64,
    mounts: i64,
    duplicates: i64,
}

#[cfg(target_os = "macos")]
fn index_record_from_entry(
    entry: MetadataEntry,
    id: String,
    parent: String,
    path: String,
) -> IndexRecord {
    IndexRecord {
        id,
        parent: Some(parent),
        name: entry.name,
        path,
        kind: if entry.kind == "file" {
            "file"
        } else {
            "directory"
        },
        own: entry.allocated_bytes.max(0),
        size: entry.allocated_bytes.max(0),
        device: entry.device,
        inode: entry.inode,
        links: entry.link_count,
        own_unreadable: 0,
        direct_children: 0,
        descendants: 0,
        unreadable: 0,
        skipped: 0,
        direct_unreadable: 0,
        symlinks: 0,
        mounts: 0,
        duplicates: 0,
    }
}

#[cfg(target_os = "macos")]
fn scan_index_subtree(
    root: File,
    root_record: IndexRecord,
    root_device: u64,
    startup: bool,
    index_exclusion: &Option<String>,
    worker: usize,
    counter: &mut usize,
    output: &mut Vec<IndexRecord>,
    cancellation: &Arc<AtomicBool>,
    progress: &Arc<NativeDatabaseProgressState>,
) -> Result<()> {
    let root_index = output.len();
    output.push(root_record);
    let mut stack = vec![(root, root_index)];
    while let Some((dir, parent_index)) = stack.pop() {
        throw_if_native_scan_canceled(cancellation)?;
        loop {
            let entries = match read_bulk_records(dir.as_raw_fd(), root_device) {
                Ok(value) => value,
                Err(_) => {
                    let parent = &mut output[parent_index];
                    parent.skipped += 1;
                    parent.direct_unreadable += 1;
                    parent.own_unreadable = 1;
                    parent.unreadable = 1;
                    break;
                }
            };
            if entries.is_empty() {
                break;
            }
            let mut page_items = 0i64;
            let mut page_bytes = 0i64;
            for entry in entries {
                let child_path = format!("{}/{}", output[parent_index].path, entry.name);
                if is_native_scan_exclusion(&child_path, startup, index_exclusion) {
                    output[parent_index].skipped += 1;
                    continue;
                }
                if entry.error_code.is_some() {
                    output[parent_index].skipped += 1;
                    output[parent_index].direct_unreadable += 1;
                    continue;
                }
                if entry.kind == "symlink" {
                    output[parent_index].skipped += 1;
                    output[parent_index].symlinks += 1;
                    continue;
                }
                if entry.mount_point
                    || entry
                        .device
                        .parse::<u64>()
                        .ok()
                        .is_some_and(|d| d != root_device)
                {
                    output[parent_index].skipped += 1;
                    output[parent_index].mounts += 1;
                    continue;
                }
                if entry.kind != "file" && entry.kind != "directory" {
                    output[parent_index].skipped += 1;
                    continue;
                }
                let id = format!("n-w{worker}x{counter}");
                *counter += 1;
                let parent = output[parent_index].id.clone();
                let is_directory = entry.kind == "directory";
                let name = entry.name.clone();
                let index = output.len();
                output.push(index_record_from_entry(entry, id, parent, child_path));
                page_items += 1;
                page_bytes = page_bytes.saturating_add(output[index].own);
                if is_directory {
                    let name = CString::new(name.into_bytes())
                        .map_err(|_| Error::from_reason("metadata path contains NUL"))?;
                    let child = unsafe {
                        libc::openat(
                            dir.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if child < 0 {
                        output[index].own_unreadable = 1;
                        output[index].unreadable = 1;
                        output[index].direct_unreadable = 1;
                        output[index].skipped = 1;
                    } else {
                        stack.push((unsafe { File::from_raw_fd(child) }, index));
                    }
                }
            }
            progress.add(page_items, page_bytes);
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn scan_tree_to_database_impl(
    target: &str,
    database_path: &str,
    cancellation: &Arc<AtomicBool>,
    progress: &Arc<NativeDatabaseProgressState>,
) -> Result<NativeDatabaseScanSummary> {
    use rusqlite::{params, Connection};
    use std::collections::HashMap;
    let started = Instant::now();
    let canonical_target =
        std::fs::canonicalize(target).map_err(|e| Error::from_reason(e.to_string()))?;
    let index_directory = Path::new(database_path)
        .parent()
        .ok_or_else(|| Error::from_reason("native index path has no parent"))?;
    let canonical_index_directory =
        std::fs::canonicalize(index_directory).map_err(|e| Error::from_reason(e.to_string()))?;
    let index_exclusion = canonical_index_directory
        .strip_prefix(&canonical_target)
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.trim_matches('/').to_owned());
    let path = CString::new(Path::new(target).as_os_str().as_bytes())
        .map_err(|_| Error::from_reason("metadata target contains NUL"))?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let root = unsafe { File::from_raw_fd(fd) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(root.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let stat = unsafe { stat.assume_init() };
    let root_device = stat.st_dev as u64;
    let volume = unsafe {
        let mut s = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if libc::fstatfs(root.as_raw_fd(), s.as_mut_ptr()) == 0 {
            let s = s.assume_init();
            format!(
                "{{\"capacityBytes\":{},\"freeBytes\":{}}}",
                s.f_blocks as u64 * s.f_bsize as u64,
                s.f_bavail as u64 * s.f_bsize as u64
            )
        } else {
            "{\"capacityBytes\":0,\"freeBytes\":0}".into()
        }
    };
    let root_own = (stat.st_blocks as i128 * 512).clamp(0, i64::MAX as i128) as i64;
    progress.add(1, root_own);
    let mut records = vec![IndexRecord {
        id: "n-root".into(),
        parent: None,
        name: Path::new(target)
            .file_name()
            .map_or_else(|| target.into(), |n| n.to_string_lossy().into_owned()),
        path: "".into(),
        kind: "directory",
        own: root_own,
        size: root_own,
        device: root_device.to_string(),
        inode: (stat.st_ino as u64).to_string(),
        links: 1,
        own_unreadable: 0,
        direct_children: 0,
        descendants: 0,
        unreadable: 0,
        skipped: 0,
        direct_unreadable: 0,
        symlinks: 0,
        mounts: 0,
        duplicates: 0,
    }];
    const THREADS: usize = 8;
    let startup = target == "/";
    // Enumerate the root on this thread so root-level files and observations stay
    // attached to the root record, then partition its directory subtrees.
    let mut jobs = VecDeque::new();
    let mut root_counter = 1usize;
    loop {
        throw_if_native_scan_canceled(cancellation)?;
        let entries = match read_bulk_records(root.as_raw_fd(), root_device) {
            Ok(value) => value,
            Err(_) => {
                let root_record = &mut records[0];
                root_record.skipped += 1;
                root_record.direct_unreadable += 1;
                root_record.own_unreadable = 1;
                root_record.unreadable = 1;
                break;
            }
        };
        if entries.is_empty() {
            break;
        }
        let mut page_items = 0i64;
        let mut page_bytes = 0i64;
        for entry in entries {
            let child_path = entry.name.clone();
            if is_native_scan_exclusion(&child_path, startup, &index_exclusion) {
                records[0].skipped += 1;
                continue;
            }
            if entry.error_code.is_some() {
                records[0].skipped += 1;
                records[0].direct_unreadable += 1;
                continue;
            }
            if entry.kind == "symlink" {
                records[0].skipped += 1;
                records[0].symlinks += 1;
                continue;
            }
            if entry.mount_point
                || entry
                    .device
                    .parse::<u64>()
                    .ok()
                    .is_some_and(|d| d != root_device)
            {
                records[0].skipped += 1;
                records[0].mounts += 1;
                continue;
            }
            if entry.kind != "file" && entry.kind != "directory" {
                records[0].skipped += 1;
                continue;
            }
            let id = format!("n-r{root_counter}");
            root_counter += 1;
            let mut record =
                index_record_from_entry(entry.clone(), id, "n-root".into(), child_path.clone());
            page_items += 1;
            page_bytes = page_bytes.saturating_add(record.own);
            if entry.kind == "directory" {
                let name = CString::new(entry.name.into_bytes())
                    .map_err(|_| Error::from_reason("metadata path contains NUL"))?;
                let child = unsafe {
                    libc::openat(
                        root.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if child < 0 {
                    record.own_unreadable = 1;
                    record.unreadable = 1;
                    record.direct_unreadable = 1;
                    record.skipped = 1;
                    records.push(record);
                } else {
                    jobs.push_back((unsafe { File::from_raw_fd(child) }, record));
                }
            } else {
                records.push(record);
            }
        }
        progress.add(page_items, page_bytes);
    }
    let jobs = Arc::new(Mutex::new(jobs));
    let mut worker_results = Vec::with_capacity(THREADS);
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(THREADS);
        for worker in 0..THREADS {
            let jobs = Arc::clone(&jobs);
            let index_exclusion = index_exclusion.clone();
            let cancellation = cancellation.clone();
            handles.push(scope.spawn(move || -> Result<Vec<IndexRecord>> {
                let mut output = Vec::new();
                let mut counter = 0usize;
                loop {
                    let job = jobs
                        .lock()
                        .map_err(|_| Error::from_reason("native index queue lock poisoned"))?
                        .pop_front();
                    let Some((file, record)) = job else { break };
                    scan_index_subtree(
                        file,
                        record,
                        root_device,
                        startup,
                        &index_exclusion,
                        worker,
                        &mut counter,
                        &mut output,
                        &cancellation,
                        &progress,
                    )?;
                }
                Ok(output)
            }));
        }
        for handle in handles {
            worker_results.push(
                handle
                    .join()
                    .map_err(|_| Error::from_reason("native index worker panicked"))?,
            );
        }
        Ok::<(), Error>(())
    })?;
    for result in worker_results {
        records.extend(result?);
    }
    let traversal_ms = started.elapsed().as_secs_f64() * 1000.0;
    progress.indexing.store(true, Ordering::Release);
    // Select hard-link ownership globally, using Rust's bytewise UTF-8 string ordering.
    let mut groups: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, r) in records.iter().enumerate() {
        if r.kind == "file" && r.links != 1 {
            groups
                .entry((r.device.clone(), r.inode.clone()))
                .or_default()
                .push(i);
        }
    }
    let mut removed = HashSet::new();
    for indexes in groups.values() {
        if indexes.len() > 1 {
            let owner = *indexes
                .iter()
                .min_by_key(|i| records[**i].path.as_bytes())
                .unwrap();
            for &i in indexes {
                if i != owner {
                    removed.insert(i);
                }
            }
        }
    }
    let id_to_index: HashMap<String, usize> = records
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.clone(), i))
        .collect();
    for i in (0..records.len()).rev() {
        if removed.contains(&i) {
            continue;
        }
        if let Some(parent) = records[i].parent.clone() {
            let p = id_to_index[&parent];
            records[p].size = records[p].size.saturating_add(records[i].size);
            records[p].direct_children += 1;
            records[p].descendants += 1 + records[i].descendants;
            records[p].unreadable += records[i].unreadable;
        }
    }
    for indexes in groups.values() {
        for &i in indexes {
            if removed.contains(&i) {
                if let Some(parent) = records[i].parent.clone() {
                    let p = id_to_index[&parent];
                    records[p].skipped += 1;
                    records[p].duplicates += 1;
                }
            }
        }
    }
    let index_started = Instant::now();
    let index_directory_metadata =
        std::fs::metadata(index_directory).map_err(|e| Error::from_reason(e.to_string()))?;
    let index_directory_identity = format!(
        "{}:{}",
        index_directory_metadata.dev(),
        index_directory_metadata.ino()
    );
    let db = Connection::open(database_path).map_err(|e| Error::from_reason(e.to_string()))?;
    db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA foreign_keys=ON; BEGIN; CREATE TABLE nodes(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES nodes(id),name TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,own_bytes INTEGER NOT NULL,size_bytes INTEGER NOT NULL,own_unreadable INTEGER NOT NULL DEFAULT 0,direct_children INTEGER NOT NULL DEFAULT 0,descendant_count INTEGER NOT NULL DEFAULT 0,unreadable_count INTEGER NOT NULL DEFAULT 0,device TEXT NOT NULL,inode TEXT NOT NULL,scan_state TEXT NOT NULL DEFAULT 'complete',enumeration_complete INTEGER NOT NULL DEFAULT 1,depth INTEGER NOT NULL); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE hardlink_paths(parent_id TEXT NOT NULL REFERENCES nodes(id),name TEXT NOT NULL,path_key TEXT PRIMARY KEY,device TEXT NOT NULL,inode TEXT NOT NULL,allocated_bytes INTEGER NOT NULL); CREATE TABLE hardlink_groups(device TEXT NOT NULL,inode TEXT NOT NULL,owner_path_key TEXT NOT NULL REFERENCES hardlink_paths(path_key),node_id TEXT NOT NULL REFERENCES nodes(id),allocated_bytes INTEGER NOT NULL,PRIMARY KEY(device,inode)); CREATE TABLE directory_observations(node_id TEXT PRIMARY KEY REFERENCES nodes(id),direct_skipped_count INTEGER NOT NULL,direct_unreadable_count INTEGER NOT NULL,direct_disappearing_count INTEGER NOT NULL,direct_symlink_count INTEGER NOT NULL,direct_nested_mount_count INTEGER NOT NULL,direct_duplicate_count INTEGER NOT NULL,enumeration_status TEXT NOT NULL);").map_err(|e| Error::from_reason(e.to_string()))?;
    {
        let mut node = db
            .prepare("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut obs = db
            .prepare("INSERT INTO directory_observations VALUES(?,?,?,?,?,?,?,?)")
            .map_err(|e| Error::from_reason(e.to_string()))?;
        for (i, r) in records.iter().enumerate() {
            if i % 4096 == 0 {
                throw_if_native_scan_canceled(cancellation)?;
            }
            if removed.contains(&i) {
                continue;
            }
            let absolute_path = if r.path.is_empty() {
                target.to_owned()
            } else if target == "/" {
                format!("/{}", r.path)
            } else {
                format!("{}/{}", target.trim_end_matches('/'), r.path)
            };
            let depth = if r.path.is_empty() {
                0
            } else {
                r.path.split('/').count() as i64
            };
            node.execute(params![
                r.id,
                r.parent,
                r.name,
                absolute_path,
                r.kind,
                r.own,
                r.size,
                r.own_unreadable,
                r.direct_children,
                r.descendants,
                r.unreadable,
                r.device,
                r.inode,
                "complete",
                1,
                depth
            ])
            .map_err(|e| Error::from_reason(e.to_string()))?;
            if r.kind == "directory" {
                obs.execute(params![
                    r.id,
                    r.skipped,
                    r.direct_unreadable,
                    0,
                    r.symlinks,
                    r.mounts,
                    r.duplicates,
                    if r.own_unreadable != 0 {
                        "unreadable"
                    } else {
                        "complete"
                    }
                ])
                .map_err(|e| Error::from_reason(e.to_string()))?;
            }
        }
        let mut hp = db
            .prepare("INSERT INTO hardlink_paths VALUES(?,?,?,?,?,?)")
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let mut hg = db
            .prepare("INSERT INTO hardlink_groups VALUES(?,?,?,?,?)")
            .map_err(|e| Error::from_reason(e.to_string()))?;
        for ((dev, ino), indexes) in &groups {
            let owner = *indexes
                .iter()
                .min_by_key(|i| records[**i].path.as_bytes())
                .unwrap();
            for &i in indexes {
                let r = &records[i];
                hp.execute(params![r.parent, r.name, r.path, r.device, r.inode, r.own])
                    .map_err(|e| Error::from_reason(e.to_string()))?;
            }
            let r = &records[owner];
            hg.execute(params![dev, ino, r.path, r.id, r.own])
                .map_err(|e| Error::from_reason(e.to_string()))?;
        }
    }
    let files = records
        .iter()
        .enumerate()
        .filter(|(i, r)| !removed.contains(i) && r.kind == "file")
        .count() as i64;
    let directories = records.iter().filter(|r| r.kind == "directory").count() as i64;
    let allocated = records[0].size;
    let skipped = records
        .iter()
        .filter(|r| r.kind == "directory")
        .map(|r| r.skipped)
        .sum::<i64>();
    let unreadable = records
        .iter()
        .filter(|r| r.kind == "directory")
        .map(|r| r.direct_unreadable)
        .sum::<i64>();
    let mounts = records.iter().map(|r| r.mounts).sum::<i64>();
    let symlinks = records.iter().map(|r| r.symlinks).sum::<i64>();
    let duplicates = removed.len() as i64;
    let scanned_items = files + directories;
    let metadata_elapsed = started.elapsed().as_millis();
    let totals=format!("{{\"scannedItems\":{scanned_items},\"discoveredBytes\":{allocated},\"elapsedMs\":{metadata_elapsed},\"skippedItems\":{skipped},\"unreadableItems\":{unreadable},\"nestedMounts\":{mounts},\"symlinks\":{symlinks},\"duplicateHardLinks\":{duplicates},\"disappearingItems\":0}}");
    {
        let mut meta = db
            .prepare("INSERT INTO metadata VALUES(?,?)")
            .map_err(|e| Error::from_reason(e.to_string()))?;
        for (k, v) in [
            ("schemaVersion", "3".into()),
            ("accountingVersion", "allocated-blocks-512-v1".into()),
            ("hardLinkOrderingVersion", "binary-relative-path-v1".into()),
            ("exclusionPolicyVersion", "startup-and-index-root-v1".into()),
            ("indexRevision", "1".into()),
            ("rootId", "n-root".into()),
            ("target", target.into()),
            ("targetDevice", root_device.to_string()),
            ("targetInode", (stat.st_ino as u64).to_string()),
            ("indexDirectoryIdentity", index_directory_identity),
            ("volume", volume),
            ("totals", totals),
            ("scannedBytes", allocated.to_string()),
        ] {
            meta.execute(params![k, v])
                .map_err(|e| Error::from_reason(e.to_string()))?;
        }
    }
    db.execute_batch("CREATE INDEX nodes_parent_size ON nodes(parent_id,size_bytes DESC,name COLLATE NOCASE ASC,id ASC); COMMIT;").map_err(|e| Error::from_reason(e.to_string()))?;
    let index_ms = index_started.elapsed().as_secs_f64() * 1000.0;
    Ok(NativeDatabaseScanSummary {
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        traversal_ms,
        index_ms,
        scanned_items,
        files,
        directories,
        allocated_bytes: allocated,
        skipped_items: skipped,
        unreadable_items: unreadable,
        nested_mounts: mounts,
        symlinks,
        duplicate_hard_links: duplicates,
    })
}

#[cfg(target_os = "macos")]
fn scan_tree_summary_impl(target: &str) -> Result<NativeScanSummary> {
    const THREADS: usize = 8;
    let started = Instant::now();
    let path = CString::new(Path::new(target).as_os_str().as_bytes())
        .map_err(|_| Error::from_reason("metadata target contains NUL"))?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let root = unsafe { File::from_raw_fd(descriptor) };
    let mut root_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(root.as_raw_fd(), root_stat.as_mut_ptr()) } != 0 {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let root_stat = unsafe { root_stat.assume_init() };
    let root_device = root_stat.st_dev as u64;
    let identities = Arc::new(Mutex::new(HashSet::<(u64, u64)>::new()));
    let startup = target == "/";
    let (mut summary, children) = scan_directory(root, "", root_device, startup, &identities)?;
    summary.scanned_items += 1;
    summary.directories += 1;
    summary.allocated_bytes = summary
        .allocated_bytes
        .saturating_add((root_stat.st_blocks as i128 * 512).clamp(0, i64::MAX as i128) as i64);
    let jobs = Arc::new(Mutex::new(VecDeque::from(children)));
    let mut worker_results = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for _ in 0..THREADS {
            let jobs = jobs.clone();
            let identities = identities.clone();
            handles.push(scope.spawn(move || -> Result<NativeScanSummary> {
                let mut total = empty_native_scan_summary();
                loop {
                    let job = jobs
                        .lock()
                        .map_err(|_| Error::from_reason("native scan queue lock poisoned"))?
                        .pop_front();
                    let Some((file, relative)) = job else {
                        break;
                    };
                    merge_native_summary(
                        &mut total,
                        scan_subtree(file, relative, root_device, startup, &identities)?,
                    );
                }
                Ok(total)
            }));
        }
        for handle in handles {
            worker_results.push(
                handle
                    .join()
                    .map_err(|_| Error::from_reason("native scan worker panicked"))?,
            );
        }
        Ok::<(), Error>(())
    })?;
    for result in worker_results {
        merge_native_summary(&mut summary, result?);
    }
    summary.elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    Ok(summary)
}

#[cfg(target_os = "macos")]
fn scan_subtree(
    root: File,
    relative: String,
    root_device: u64,
    startup: bool,
    identities: &Arc<Mutex<HashSet<(u64, u64)>>>,
) -> Result<NativeScanSummary> {
    let mut total = empty_native_scan_summary();
    let mut stack = vec![(root, relative)];
    while let Some((file, relative)) = stack.pop() {
        let (summary, children) =
            scan_directory(file, &relative, root_device, startup, identities)?;
        merge_native_summary(&mut total, summary);
        stack.extend(children);
    }
    Ok(total)
}

#[cfg(target_os = "macos")]
fn scan_directory(
    file: File,
    relative: &str,
    root_device: u64,
    startup: bool,
    identities: &Arc<Mutex<HashSet<(u64, u64)>>>,
) -> Result<(NativeScanSummary, Vec<(File, String)>)> {
    let mut summary = empty_native_scan_summary();
    let mut pending = Vec::new();
    loop {
        summary.bulk_calls += 1;
        let entries = match read_bulk_records(file.as_raw_fd(), root_device) {
            Ok(entries) => entries,
            Err(_) => {
                summary.skipped_items += 1;
                summary.unreadable_items += 1;
                break;
            }
        };
        if entries.is_empty() {
            break;
        }
        for entry in entries {
            let child_path = if relative.is_empty() {
                entry.name.clone()
            } else {
                format!("{relative}/{}", entry.name)
            };
            if startup && is_startup_exclusion(&child_path) {
                summary.skipped_items += 1;
                continue;
            }
            if entry.error_code.is_some() {
                summary.skipped_items += 1;
                summary.unreadable_items += 1;
                continue;
            }
            if entry.kind == "symlink" {
                summary.skipped_items += 1;
                summary.symlinks += 1;
                continue;
            }
            if entry.mount_point
                || entry
                    .device
                    .parse::<u64>()
                    .ok()
                    .is_some_and(|device| device != root_device)
            {
                summary.skipped_items += 1;
                summary.nested_mounts += 1;
                continue;
            }
            if entry.kind != "file" && entry.kind != "directory" {
                summary.skipped_items += 1;
                continue;
            }
            let identity = entry
                .device
                .parse::<u64>()
                .ok()
                .zip(entry.inode.parse::<u64>().ok());
            if entry.kind == "file"
                && entry.link_count != 1
                && identity.is_some_and(|value| {
                    identities
                        .lock()
                        .map_or(true, |mut seen| !seen.insert(value))
                })
            {
                summary.skipped_items += 1;
                summary.duplicate_hard_links += 1;
                continue;
            }
            if entry.kind == "directory" {
                summary.directories += 1;
                let name = CString::new(entry.name.into_bytes())
                    .map_err(|_| Error::from_reason("metadata path contains NUL"))?;
                let child = unsafe {
                    libc::openat(
                        file.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if child < 0 {
                    summary.skipped_items += 1;
                    summary.unreadable_items += 1;
                } else {
                    pending.push((unsafe { File::from_raw_fd(child) }, child_path));
                }
            } else {
                summary.files += 1;
            }
            summary.scanned_items += 1;
            summary.allocated_bytes = summary
                .allocated_bytes
                .saturating_add(entry.allocated_bytes.max(0));
        }
    }
    Ok((summary, pending))
}

#[cfg(target_os = "macos")]
fn throw_if_native_scan_canceled(cancellation: &Arc<AtomicBool>) -> Result<()> {
    if cancellation.load(Ordering::Relaxed) {
        Err(Error::from_reason("scan canceled"))
    } else {
        Ok(())
    }
}

fn empty_native_scan_summary() -> NativeScanSummary {
    NativeScanSummary {
        elapsed_ms: 0.0,
        scanned_items: 0,
        files: 0,
        directories: 0,
        allocated_bytes: 0,
        skipped_items: 0,
        unreadable_items: 0,
        nested_mounts: 0,
        symlinks: 0,
        duplicate_hard_links: 0,
        bulk_calls: 0,
    }
}

fn merge_native_summary(total: &mut NativeScanSummary, value: NativeScanSummary) {
    total.scanned_items += value.scanned_items;
    total.files += value.files;
    total.directories += value.directories;
    total.allocated_bytes = total.allocated_bytes.saturating_add(value.allocated_bytes);
    total.skipped_items += value.skipped_items;
    total.unreadable_items += value.unreadable_items;
    total.nested_mounts += value.nested_mounts;
    total.symlinks += value.symlinks;
    total.duplicate_hard_links += value.duplicate_hard_links;
    total.bulk_calls += value.bulk_calls;
}

#[cfg(target_os = "macos")]
fn is_native_scan_exclusion(
    relative: &str,
    startup: bool,
    index_exclusion: &Option<String>,
) -> bool {
    startup && is_startup_exclusion(relative)
        || index_exclusion.as_ref().is_some_and(|excluded| {
            excluded.is_empty()
                || relative == excluded
                || relative
                    .strip_prefix(excluded)
                    .is_some_and(|rest| rest.starts_with('/'))
        })
}

#[cfg(target_os = "macos")]
fn is_startup_exclusion(relative: &str) -> bool {
    const EXCLUSIONS: [&str; 8] = [
        "System/Volumes",
        "Volumes",
        "dev",
        "Network",
        "net",
        "automount",
        "private/var/automount",
        "private/var/run",
    ];
    EXCLUSIONS.iter().any(|excluded| {
        relative == *excluded
            || relative
                .strip_prefix(excluded)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn io_error(error: std::io::Error) -> Error {
    Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::fs;

    #[cfg(target_os = "macos")]
    #[test]
    fn native_scan_excludes_the_entire_index_root_when_it_is_the_target() {
        assert!(is_native_scan_exclusion(
            "index.sqlite",
            false,
            &Some(String::new())
        ));
    }

    #[test]
    fn clamps_page_limits_to_supported_range() {
        assert_eq!(clamp_page_limit(0), 1);
        assert_eq!(clamp_page_limit(512), 512);
        assert_eq!(clamp_page_limit(2_048), 1_024);
    }

    #[test]
    fn encodes_packed_metadata_pages() {
        let entries = vec![
            MetadataEntry {
                name: "café".into(),
                kind: "file".into(),
                device: "7".into(),
                inode: "9".into(),
                allocated_bytes: 4096,
                link_count: 2,
                mount_point: true,
                error_code: None,
            },
            MetadataEntry {
                name: "denied".into(),
                kind: "other".into(),
                device: "".into(),
                inode: "".into(),
                allocated_bytes: 0,
                link_count: 0,
                mount_point: false,
                error_code: Some(13),
            },
        ];
        let packed = encode_metadata_page(&entries);
        assert_eq!(&packed[0..4], b"ORB1");
        assert_eq!(u16::from_le_bytes(packed[4..6].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(packed[6..8].try_into().unwrap()), 48);
        assert_eq!(u32::from_le_bytes(packed[8..12].try_into().unwrap()), 2);
        assert_eq!(packed[24], 1);
        assert_eq!(packed[25] & 0x0f, 0x0f);
        assert_eq!(i32::from_le_bytes(packed[76..80].try_into().unwrap()), 13);
        assert_eq!(&packed[112..], "cafédenied".as_bytes());
        assert_eq!(encode_metadata_page(&[]).len(), 16);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn descriptor_tree_rejects_symlink_components() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "orbis-tree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("real/child")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        symlink(root.join("real/child"), root.join("real/final-alias")).unwrap();
        let tree = open_metadata_tree(root.to_string_lossy().into_owned()).unwrap();
        assert!(tree.open_directory("real/child".into()).is_ok());
        assert!(tree.open_directory("alias/child".into()).is_err());
        assert!(tree.open_directory("real/final-alias".into()).is_err());
        for invalid in ["/absolute", "a//b", ".", "..", "a/../b"] {
            assert!(tree.open_directory(invalid.into()).is_err());
        }
        tree.close();
        assert!(tree.open_directory("".into()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fills_a_page_across_multiple_bulk_reads() {
        let mut pending = VecDeque::new();
        let mut done = false;
        let mut chunks = VecDeque::from([
            vec![entry("one"), entry("two")],
            vec![entry("three"), entry("four")],
        ]);
        let (entries, error) = fill_requested_entries(&mut pending, &mut done, 3, || {
            Ok::<_, ()>(chunks.pop_front().unwrap_or_default())
        });
        assert!(error.is_none());
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["one", "two", "three"]
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].name, "four");
    }

    #[test]
    fn empty_pages_are_terminal() {
        let page = empty_page(true);
        assert!(page.done);
        assert!(page.entries.is_empty());
    }

    fn entry(name: &str) -> MetadataEntry {
        MetadataEntry {
            name: name.to_owned(),
            kind: "file".to_owned(),
            device: String::new(),
            inode: String::new(),
            allocated_bytes: 0,
            link_count: 1,
            mount_point: false,
            error_code: None,
        }
    }

    #[cfg(target_os = "macos")]
    fn fixed(
        commonattr: u32,
        dirattr: u32,
        fileattr: u32,
        devid: u32,
        vtype: u32,
        fileid: u64,
        linkcount: u32,
        allocsize: u64,
        dir_allocsize: u64,
    ) -> Vec<u8> {
        let mut fixed = Vec::new();
        if commonattr & libc::ATTR_CMN_DEVID != 0 {
            fixed.extend_from_slice(&devid.to_ne_bytes());
        }
        if commonattr & libc::ATTR_CMN_OBJTYPE != 0 {
            fixed.extend_from_slice(&vtype.to_ne_bytes());
        }
        if commonattr & libc::ATTR_CMN_FILEID != 0 {
            fixed.extend_from_slice(&fileid.to_ne_bytes());
        }
        if dirattr & libc::ATTR_DIR_ALLOCSIZE != 0 {
            fixed.extend_from_slice(&dir_allocsize.to_ne_bytes());
        }
        if fileattr & libc::ATTR_FILE_LINKCOUNT != 0 {
            fixed.extend_from_slice(&linkcount.to_ne_bytes());
        }
        if fileattr & libc::ATTR_FILE_ALLOCSIZE != 0 {
            fixed.extend_from_slice(&allocsize.to_ne_bytes());
        }
        fixed
    }

    // Builds a synthetic bulk record: [length][attrset][error?][name ref][fixed][name data],
    // padded to an 8-byte boundary like the kernel does.
    #[cfg(target_os = "macos")]
    fn synthetic_record(
        commonattr: u32,
        dirattr: u32,
        fileattr: u32,
        error: Option<u32>,
        name: &str,
        fixed: &[u8],
    ) -> Vec<u8> {
        let mut record = Vec::new();
        record.extend_from_slice(&0_u32.to_ne_bytes());
        record.extend_from_slice(&commonattr.to_ne_bytes());
        record.extend_from_slice(&0_u32.to_ne_bytes());
        record.extend_from_slice(&dirattr.to_ne_bytes());
        record.extend_from_slice(&fileattr.to_ne_bytes());
        record.extend_from_slice(&0_u32.to_ne_bytes());
        if let Some(errno) = error {
            record.extend_from_slice(&errno.to_ne_bytes());
        }
        let name_with_nul = [name.as_bytes(), &[0]].concat();
        let reference_start = record.len();
        record.extend_from_slice(&0_i32.to_ne_bytes());
        record.extend_from_slice(&(name_with_nul.len() as u32).to_ne_bytes());
        record.extend_from_slice(fixed);
        let data_start = record.len();
        record[reference_start..reference_start + 4]
            .copy_from_slice(&((data_start - reference_start) as i32).to_ne_bytes());
        record.extend_from_slice(&name_with_nul);
        while record.len() % 8 != 0 {
            record.push(0);
        }
        let length = record.len() as u32;
        record[0..4].copy_from_slice(&length.to_ne_bytes());
        record
    }

    #[cfg(target_os = "macos")]
    const COMMON_FULL: u32 = libc::ATTR_CMN_RETURNED_ATTRS
        | libc::ATTR_CMN_NAME
        | libc::ATTR_CMN_DEVID
        | libc::ATTR_CMN_OBJTYPE
        | libc::ATTR_CMN_FILEID;

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_full_attribute_bulk_records() {
        let mut buffer = Vec::new();
        buffer.extend(synthetic_record(
            COMMON_FULL,
            0,
            libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
            None,
            "file.txt",
            &fixed(
                COMMON_FULL,
                0,
                libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
                16777231,
                1,
                74202030,
                2,
                4096,
                0,
            ),
        ));
        buffer.extend(synthetic_record(
            COMMON_FULL,
            libc::ATTR_DIR_ALLOCSIZE,
            0,
            None,
            "sub",
            &fixed(
                COMMON_FULL,
                libc::ATTR_DIR_ALLOCSIZE,
                0,
                16777231,
                2,
                74202029,
                0,
                0,
                0,
            ),
        ));
        buffer.extend(synthetic_record(
            COMMON_FULL,
            0,
            libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
            None,
            "link",
            &fixed(
                COMMON_FULL,
                0,
                libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
                16777231,
                5,
                74202028,
                1,
                0,
                0,
            ),
        ));
        let entries = parse_bulk_records(&buffer, 3, 16777231).expect("bulk records parse");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "file.txt");
        assert_eq!(entries[0].kind, "file");
        assert_eq!(entries[0].device, "16777231");
        assert_eq!(entries[0].inode, "74202030");
        assert_eq!(entries[0].allocated_bytes, 4096);
        assert_eq!(entries[0].link_count, 2);
        assert!(!entries[0].mount_point);
        assert_eq!(entries[0].error_code, None);
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, "directory");
        assert_eq!(entries[1].inode, "74202029");
        assert_eq!(entries[1].allocated_bytes, 0);
        assert!(!entries[1].mount_point);
        assert_eq!(entries[2].name, "link");
        assert_eq!(entries[2].kind, "symlink");
        assert_eq!(entries[2].link_count, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn marks_directories_on_other_devices_as_mount_points() {
        let buffer = synthetic_record(
            COMMON_FULL,
            libc::ATTR_DIR_ALLOCSIZE,
            0,
            None,
            "mnt",
            &fixed(
                COMMON_FULL,
                libc::ATTR_DIR_ALLOCSIZE,
                0,
                999,
                2,
                42,
                0,
                0,
                0,
            ),
        );
        let entries = parse_bulk_records(&buffer, 1, 16777231).expect("bulk records parse");
        assert_eq!(entries[0].kind, "directory");
        assert!(entries[0].mount_point);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_error_records_without_failing() {
        let buffer = synthetic_record(
            libc::ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR | libc::ATTR_CMN_NAME,
            0,
            0,
            Some(13),
            "bad",
            &[],
        );
        let entries = parse_bulk_records(&buffer, 1, 16777231).expect("bulk records parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "bad");
        assert_eq!(entries[0].error_code, Some(13));
        assert_eq!(entries[0].kind, "other");
        assert_eq!(entries[0].device, "");
        assert_eq!(entries[0].inode, "");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn skips_error_records_without_names() {
        let mut record = synthetic_record(
            libc::ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR | libc::ATTR_CMN_NAME,
            0,
            0,
            Some(2),
            "x",
            &[],
        );
        // Drop the NAME bit: the record then carries only ERROR and must be
        // skipped rather than fail the directory.
        record[4..8]
            .copy_from_slice(&(libc::ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR).to_ne_bytes());
        let entries = parse_bulk_records(&record, 1, 16777231).expect("bulk records parse");
        assert!(entries.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn defaults_missing_attributes() {
        let buffer = synthetic_record(
            libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_NAME,
            0,
            0,
            None,
            "min",
            &[],
        );
        let entries = parse_bulk_records(&buffer, 1, 16777231).expect("bulk records parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "min");
        assert_eq!(entries[0].kind, "other");
        assert_eq!(entries[0].device, "");
        assert_eq!(entries[0].inode, "");
        assert_eq!(entries[0].allocated_bytes, 0);
        assert_eq!(entries[0].link_count, 1);
        assert!(!entries[0].mount_point);
        assert_eq!(entries[0].error_code, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_truncated_records() {
        let mut buffer = synthetic_record(
            COMMON_FULL,
            0,
            libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
            None,
            "file.txt",
            &fixed(
                COMMON_FULL,
                0,
                libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
                16777231,
                1,
                74202030,
                2,
                4096,
                0,
            ),
        );
        buffer.truncate(40); // The record claims 80 bytes but only 40 remain.
        assert!(parse_bulk_records(&buffer, 1, 16777231).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_invalid_name_references() {
        let mut record = synthetic_record(
            libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_NAME,
            0,
            0,
            None,
            "x",
            &[],
        );
        // Corrupt the reference offset to point past the record end.
        record[24..28].copy_from_slice(&1_000_i32.to_ne_bytes());
        assert!(parse_bulk_records(&record, 1, 16777231).is_err());
    }
}
