#![deny(clippy::all)]

mod fsevents;
pub use fsevents::{capture_volume_checkpoint, read_changes};

use napi::bindgen_prelude::{AsyncTask, Buffer, Error, Result, Task};
use napi_derive::napi;
use std::collections::{HashSet, VecDeque};
#[cfg(target_os = "macos")]
use std::fs::File;
#[cfg(target_os = "macos")]
use std::ffi::CString;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
#[cfg(target_os = "macos")]
use std::os::unix::io::{AsRawFd, FromRawFd};
#[cfg(target_os = "macos")]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::time::Instant;
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

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
        { scan_tree_summary_impl(&self.target) }
        #[cfg(not(target_os = "macos"))]
        { Err(Error::from_reason("native tree scanning is only available on macOS")) }
    }

    fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> { Ok(output) }
}

#[napi]
pub fn scan_tree_summary(target: String) -> AsyncTask<NativeScanTask> {
    AsyncTask::new(NativeScanTask { target })
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
                payload: encode_metadata_page(&page.entries), count, done: page.done,
                bulk_entries: page.bulk_entries, fallback_entries: page.fallback_entries,
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
            payload: output.payload.into(), count: output.count, done: output.done,
            bulk_entries: output.bulk_entries, fallback_entries: output.fallback_entries,
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
            let root = self.root.lock().map_err(|_| Error::from_reason("metadata tree lock poisoned"))?;
            let root = root.as_ref().ok_or_else(|| Error::from_reason("metadata tree is closed"))?;
            let duplicated = unsafe { libc::dup(root.as_raw_fd()) };
            if duplicated < 0 { return Err(io_error(std::io::Error::last_os_error())); }
            let mut file = unsafe { File::from_raw_fd(duplicated) };
            for component in relative_path.split('/').filter(|component| !component.is_empty()) {
                let name = CString::new(component.as_bytes()).map_err(|_| Error::from_reason("metadata path contains NUL"))?;
                let descriptor = unsafe { libc::openat(file.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
                if descriptor < 0 { return Err(io_error(std::io::Error::last_os_error())); }
                file = unsafe { File::from_raw_fd(descriptor) };
            }
            return cursor_from_file(file);
        }
        #[cfg(not(target_os = "macos"))]
        { let _ = relative_path; Err(Error::from_reason("getattrlistbulk is only available on macOS")) }
    }

    #[napi]
    pub fn close(&self) {
        #[cfg(target_os = "macos")]
        if let Ok(mut root) = self.root.lock() { root.take(); }
    }
}

#[napi]
pub fn open_metadata_tree(target: String) -> Result<MetadataTree> {
    #[cfg(target_os = "macos")]
    {
        let path = CString::new(Path::new(&target).as_os_str().as_bytes()).map_err(|_| Error::from_reason("metadata target contains NUL"))?;
        let descriptor = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if descriptor < 0 { return Err(io_error(std::io::Error::last_os_error())); }
        let file = unsafe { File::from_raw_fd(descriptor) };
        return Ok(MetadataTree { root: Arc::new(Mutex::new(Some(file))) });
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = target; Err(Error::from_reason("getattrlistbulk is only available on macOS")) }
}

#[cfg(target_os = "macos")]
fn validate_relative_path(path: &str) -> Result<()> {
    if path.starts_with('/') || path.as_bytes().contains(&0) || path.split('/').any(|part| part.is_empty() && !path.is_empty() || part == "." || part == "..") {
        return Err(Error::from_reason("invalid relative metadata path"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn cursor_from_file(file: File) -> Result<DirectoryCursor> {
    use std::mem::MaybeUninit;
    let mut stat = MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 { return Err(io_error(std::io::Error::last_os_error())); }
    let stat = unsafe { stat.assume_init() };
    Ok(DirectoryCursor { inner: Arc::new(Mutex::new(CursorState {
        parent_device: stat.st_dev as u64, file: Some(file), pending_bulk: VecDeque::new(), bulk_done: false, closed: false,
    })) })
}

fn encode_metadata_page(entries: &[MetadataEntry]) -> Vec<u8> {
    const HEADER_SIZE: usize = 16;
    const RECORD_SIZE: usize = 48;
    let name_bytes = entries.iter().map(|entry| entry.name.as_bytes().len()).sum::<usize>();
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
        output[record + 8] = match entry.kind.as_str() { "file" => 1, "directory" => 2, "symlink" => 3, _ => 0 };
        let device = entry.device.parse::<u64>().ok();
        let inode = entry.inode.parse::<u64>().ok();
        let link_count = u64::try_from(entry.link_count).ok();
        let mut flags = if entry.mount_point { 1 } else { 0 };
        if device.is_some() { flags |= 1 << 1; }
        if inode.is_some() { flags |= 1 << 2; }
        if link_count.is_some() { flags |= 1 << 3; }
        if entry.error_code.is_some() { flags |= 1 << 4; }
        output[record + 9] = flags;
        output[record + 12..record + 16].copy_from_slice(&entry.error_code.unwrap_or(0).to_le_bytes());
        output[record + 16..record + 24].copy_from_slice(&device.unwrap_or(0).to_le_bytes());
        output[record + 24..record + 32].copy_from_slice(&inode.unwrap_or(0).to_le_bytes());
        output[record + 32..record + 40].copy_from_slice(&(entry.allocated_bytes.max(0) as u64).to_le_bytes());
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
    let file = state.file.as_ref().ok_or_else(|| Error::from_reason("metadata cursor is closed"))?;
    let (entries, bulk_error) = fill_requested_entries(
        &mut state.pending_bulk, &mut state.bulk_done, safe_limit,
        || read_bulk_records(file.as_raw_fd(), state.parent_device),
    );
    if let Some(error) = bulk_error { return Err(error); }
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
fn read_bulk_records(fd: std::os::unix::io::RawFd, parent_device: u64) -> Result<Vec<MetadataEntry>> {
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
fn parse_bulk_records(buffer: &[u8], count: usize, parent_device: u64) -> Result<Vec<MetadataEntry>> {
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
            return Err(Error::from_reason("getattrlistbulk returned an invalid record length"));
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
            error_code = Some(u32::from_ne_bytes(
                buffer[cursor..cursor + 4].try_into().unwrap(),
            ) as i32);
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
            let data_start = usize::try_from(reference_offset).ok().and_then(|relative| cursor.checked_add(relative));
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
            1 => "file",       // VREG
            2 => "directory",  // VDIR
            5 => "symlink",    // VLNK
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
fn scan_tree_summary_impl(target: &str) -> Result<NativeScanSummary> {
    struct Frame {
        file: File,
        relative: String,
        children: VecDeque<(String, String)>,
        enumerated: bool,
    }

    let started = Instant::now();
    let path = CString::new(Path::new(target).as_os_str().as_bytes()).map_err(|_| Error::from_reason("metadata target contains NUL"))?;
    let descriptor = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if descriptor < 0 { return Err(io_error(std::io::Error::last_os_error())); }
    let root = unsafe { File::from_raw_fd(descriptor) };
    let mut root_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(root.as_raw_fd(), root_stat.as_mut_ptr()) } != 0 { return Err(io_error(std::io::Error::last_os_error())); }
    let root_stat = unsafe { root_stat.assume_init() };
    let root_device = root_stat.st_dev as u64;
    let mut summary = NativeScanSummary {
        elapsed_ms: 0.0, scanned_items: 1, files: 0, directories: 1,
        allocated_bytes: (root_stat.st_blocks as i128 * 512).clamp(0, i64::MAX as i128) as i64,
        skipped_items: 0, unreadable_items: 0, nested_mounts: 0, symlinks: 0,
        duplicate_hard_links: 0, bulk_calls: 0,
    };
    let mut identities = HashSet::<(u64, u64)>::new();
    identities.insert((root_device, root_stat.st_ino as u64));
    let startup = target == "/";
    let mut stack = vec![Frame { file: root, relative: String::new(), children: VecDeque::new(), enumerated: false }];

    while !stack.is_empty() {
        let descend = {
            let frame = stack.last_mut().unwrap();
            if !frame.enumerated {
                loop {
                    summary.bulk_calls += 1;
                    let entries = match read_bulk_records(frame.file.as_raw_fd(), root_device) {
                        Ok(entries) => entries,
                        Err(_) => {
                            summary.skipped_items += 1;
                            summary.unreadable_items += 1;
                            break;
                        }
                    };
                    if entries.is_empty() { break; }
                    for entry in entries {
                        let relative = if frame.relative.is_empty() { entry.name.clone() } else { format!("{}/{}", frame.relative, entry.name) };
                        if startup && is_startup_exclusion(&relative) {
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
                        if entry.mount_point || entry.device.parse::<u64>().ok().is_some_and(|device| device != root_device) {
                            summary.skipped_items += 1;
                            summary.nested_mounts += 1;
                            continue;
                        }
                        if entry.kind != "file" && entry.kind != "directory" {
                            summary.skipped_items += 1;
                            continue;
                        }
                        let identity = entry.device.parse::<u64>().ok().zip(entry.inode.parse::<u64>().ok());
                        if entry.kind == "file" && entry.link_count != 1 && identity.is_some_and(|value| !identities.insert(value)) {
                            summary.skipped_items += 1;
                            summary.duplicate_hard_links += 1;
                            continue;
                        }
                        if entry.kind == "directory" {
                            if let Some(value) = identity { identities.insert(value); }
                            summary.directories += 1;
                            frame.children.push_back((entry.name, relative));
                        } else {
                            summary.files += 1;
                        }
                        summary.scanned_items += 1;
                        summary.allocated_bytes = summary.allocated_bytes.saturating_add(entry.allocated_bytes.max(0));
                    }
                }
                frame.enumerated = true;
            }
            frame.children.pop_front().map(|(name, relative)| (frame.file.as_raw_fd(), name, relative))
        };
        if let Some((parent_fd, name, relative)) = descend {
            let name = CString::new(name.into_bytes()).map_err(|_| Error::from_reason("metadata path contains NUL"))?;
            let child = unsafe { libc::openat(parent_fd, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
            if child < 0 {
                summary.skipped_items += 1;
                summary.unreadable_items += 1;
                continue;
            }
            stack.push(Frame { file: unsafe { File::from_raw_fd(child) }, relative, children: VecDeque::new(), enumerated: false });
        } else {
            stack.pop();
        }
    }
    summary.elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    Ok(summary)
}

#[cfg(target_os = "macos")]
fn is_startup_exclusion(relative: &str) -> bool {
    const EXCLUSIONS: [&str; 8] = [
        "System/Volumes", "Volumes", "dev", "Network", "net", "automount", "private/var/automount", "private/var/run",
    ];
    EXCLUSIONS.iter().any(|excluded| relative == *excluded || relative.strip_prefix(excluded).is_some_and(|rest| rest.starts_with('/')))
}

fn io_error(error: std::io::Error) -> Error {
    Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::fs;

    #[test]
    fn clamps_page_limits_to_supported_range() {
        assert_eq!(clamp_page_limit(0), 1);
        assert_eq!(clamp_page_limit(512), 512);
        assert_eq!(clamp_page_limit(2_048), 1_024);
    }

    #[test]
    fn encodes_packed_metadata_pages() {
        let entries = vec![MetadataEntry {
            name: "café".into(), kind: "file".into(), device: "7".into(), inode: "9".into(),
            allocated_bytes: 4096, link_count: 2, mount_point: true, error_code: None,
        }, MetadataEntry {
            name: "denied".into(), kind: "other".into(), device: "".into(), inode: "".into(),
            allocated_bytes: 0, link_count: 0, mount_point: false, error_code: Some(13),
        }];
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
        let root = std::env::temp_dir().join(format!("orbis-tree-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("real/child")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        symlink(root.join("real/child"), root.join("real/final-alias")).unwrap();
        let tree = open_metadata_tree(root.to_string_lossy().into_owned()).unwrap();
        assert!(tree.open_directory("real/child".into()).is_ok());
        assert!(tree.open_directory("alias/child".into()).is_err());
        assert!(tree.open_directory("real/final-alias".into()).is_err());
        for invalid in ["/absolute", "a//b", ".", "..", "a/../b"] { assert!(tree.open_directory(invalid.into()).is_err()); }
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
            entries.iter().map(|entry| entry.name.as_str()).collect::<Vec<_>>(),
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
            &fixed(COMMON_FULL, 0, libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE, 16777231, 1, 74202030, 2, 4096, 0),
        ));
        buffer.extend(synthetic_record(
            COMMON_FULL,
            libc::ATTR_DIR_ALLOCSIZE,
            0,
            None,
            "sub",
            &fixed(COMMON_FULL, libc::ATTR_DIR_ALLOCSIZE, 0, 16777231, 2, 74202029, 0, 0, 0),
        ));
        buffer.extend(synthetic_record(
            COMMON_FULL,
            0,
            libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE,
            None,
            "link",
            &fixed(COMMON_FULL, 0, libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE, 16777231, 5, 74202028, 1, 0, 0),
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
            &fixed(COMMON_FULL, libc::ATTR_DIR_ALLOCSIZE, 0, 999, 2, 42, 0, 0, 0),
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
        record[4..8].copy_from_slice(&(libc::ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR).to_ne_bytes());
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
            &fixed(COMMON_FULL, 0, libc::ATTR_FILE_LINKCOUNT | libc::ATTR_FILE_ALLOCSIZE, 16777231, 1, 74202030, 2, 4096, 0),
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
