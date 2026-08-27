#![deny(clippy::all)]

mod fsevents;
pub use fsevents::{capture_volume_checkpoint, read_changes};

use napi::bindgen_prelude::{AsyncTask, Error, Result, Task};
use napi_derive::napi;
use std::collections::VecDeque;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::fs::{self, File};
#[cfg(target_os = "macos")]
use std::os::unix::io::AsRawFd;
#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

// Not exposed by the libc crate; from <sys/attr.h> (ATTR_CMN_ERROR 0x20000000).
#[cfg(target_os = "macos")]
const ATTR_CMN_ERROR: u32 = 0x2000_0000;

#[napi(object)]
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

#[napi(object)]
pub struct MetadataPage {
    pub entries: Vec<MetadataEntry>,
    pub done: bool,
    pub bulk_entries: i64,
    pub fallback_entries: i64,
}

#[napi]
pub struct DirectoryCursor {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<CursorState>>,
}

#[cfg(target_os = "macos")]
struct CursorState {
    path: PathBuf,
    parent_device: u64,
    file: Arc<File>,
    pending_bulk: VecDeque<MetadataEntry>,
    bulk_done: bool,
    fallback_names: Option<Vec<String>>,
    fallback_index: usize,
    emitted_names: HashSet<String>,
    closed: bool,
}

pub struct ReadPageTask {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<CursorState>>,
    limit: usize,
}

impl Task for ReadPageTask {
    type Output = MetadataPage;
    type JsValue = MetadataPage;

    fn compute(&mut self) -> Result<Self::Output> {
        #[cfg(target_os = "macos")]
        {
            let mut state = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("metadata cursor lock poisoned"))?;
            read_page_from_state(&mut state, self.limit)
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
        Ok(output)
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
        }
    }
}

#[napi]
pub fn open_directory(path: String) -> Result<DirectoryCursor> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::MetadataExt;
        let path_buf = PathBuf::from(path);
        let metadata = fs::symlink_metadata(&path_buf).map_err(io_error)?;
        if !metadata.is_dir() {
            return Err(Error::from_reason("metadata cursor requires a directory"));
        }
        let file = File::open(&path_buf).map_err(io_error)?;
        return Ok(DirectoryCursor {
            inner: Arc::new(Mutex::new(CursorState {
                path: path_buf,
                parent_device: metadata.dev(),
                file: Arc::new(file),
                pending_bulk: VecDeque::new(),
                bulk_done: false,
                fallback_names: None,
                fallback_index: 0,
                emitted_names: HashSet::new(),
                closed: false,
            })),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(Error::from_reason(
            "getattrlistbulk is only available on macOS",
        ))
    }
}

fn clamp_page_limit(limit: u32) -> usize {
    limit.clamp(1, 1_024) as usize
}

#[cfg(target_os = "macos")]
fn read_page_from_state(state: &mut CursorState, safe_limit: usize) -> Result<MetadataPage> {
    if state.closed {
        return Ok(empty_page(true));
    }
    if let Some(names) = state.fallback_names.as_ref() {
        let start = state.fallback_index;
        let end = (start + safe_limit).min(names.len());
        let entries = names[start..end]
            .iter()
            .map(|name| metadata_entry(&state.path, name, state.parent_device))
            .collect::<Vec<_>>();
        state.fallback_index = end;
        return Ok(MetadataPage {
            done: end == names.len(),
            bulk_entries: 0,
            fallback_entries: entries.len() as i64,
            entries,
        });
    }
    let (entries, bulk_error) = fill_requested_entries(
        &mut state.pending_bulk,
        &mut state.bulk_done,
        safe_limit,
        || read_bulk_records(state.file.as_raw_fd(), state.parent_device),
    );
    let bulk_entries = entries.len();
    for entry in &entries {
        state.emitted_names.insert(entry.name.clone());
    }
    if bulk_error.is_some() {
        let fallback_names = read_fallback_names(&state.path, &state.emitted_names)?;
        let take = (safe_limit - entries.len()).min(fallback_names.len());
        let mut entries = entries;
        entries.extend(
            fallback_names[..take]
                .iter()
                .map(|name| metadata_entry(&state.path, name, state.parent_device)),
        );
        state.fallback_index = take;
        state.fallback_names = Some(fallback_names);
        return Ok(MetadataPage {
            done: state
                .fallback_names
                .as_ref()
                .is_some_and(|fallback| state.fallback_index == fallback.len()),
            bulk_entries: bulk_entries as i64,
            fallback_entries: (entries.len() - bulk_entries) as i64,
            entries,
        });
    }
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
fn metadata_entry(directory: &Path, name: &str, parent_device: u64) -> MetadataEntry {
    use std::os::unix::fs::MetadataExt;
    let path = directory.join(name);
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let kind = if metadata.file_type().is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                "other"
            };
            MetadataEntry {
                name: name.to_owned(),
                kind: kind.to_owned(),
                device: metadata.dev().to_string(),
                inode: metadata.ino().to_string(),
                allocated_bytes: (metadata.blocks() as i128 * 512).min(i64::MAX as i128) as i64,
                link_count: metadata.nlink().min(i64::MAX as u64) as i64,
                mount_point: metadata.is_dir() && metadata.dev() != parent_device,
                error_code: None,
            }
        }
        Err(error) => MetadataEntry {
            name: name.to_owned(),
            kind: "other".to_owned(),
            device: String::new(),
            inode: String::new(),
            allocated_bytes: 0,
            link_count: 0,
            mount_point: false,
            error_code: error.raw_os_error(),
        },
    }
}

#[cfg(target_os = "macos")]
fn read_fallback_names(directory: &Path, emitted: &HashSet<String>) -> Result<Vec<String>> {
    let mut names = fs::read_dir(directory)
        .map_err(io_error)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !emitted.contains(name) && !name.is_empty() && name != "." && name != "..")
        .collect::<Vec<_>>();
    names.sort_unstable();
    Ok(names)
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
        if offset + 32 > buffer.len() {
            return Err(Error::from_reason(
                "getattrlistbulk returned a truncated record",
            ));
        }
        let record_length =
            u32::from_ne_bytes(buffer[offset..offset + 4].try_into().unwrap()) as usize;
        if record_length < 32 || offset + record_length > buffer.len() {
            return Err(Error::from_reason(
                "getattrlistbulk returned an invalid record length",
            ));
        }
        let record_end = offset + record_length;
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
            let data_start = (cursor as isize + reference_offset as isize) as usize;
            if reference_offset < 0
                || data_start < cursor + 8
                || data_start >= record_end
                || reference_length == 0
                || data_start + reference_length > record_end
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
            let bytes = &buffer[data_start..data_start + reference_length];
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

fn io_error(error: std::io::Error) -> Error {
    Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_page_limits_to_supported_range() {
        assert_eq!(clamp_page_limit(0), 1);
        assert_eq!(clamp_page_limit(512), 512);
        assert_eq!(clamp_page_limit(2_048), 1_024);
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
