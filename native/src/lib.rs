#![deny(clippy::all)]

mod fsevents;
pub use fsevents::{capture_volume_checkpoint, read_changes};

use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;
use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
#[cfg(target_os = "macos")]
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

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
    path: PathBuf,
    parent_device: u64,
    closed: bool,
    #[cfg(target_os = "macos")]
    file: File,
    #[cfg(target_os = "macos")]
    pending_bulk: VecDeque<String>,
    #[cfg(target_os = "macos")]
    bulk_done: bool,
    #[cfg(target_os = "macos")]
    fallback_names: Option<Vec<String>>,
    #[cfg(target_os = "macos")]
    fallback_index: usize,
    #[cfg(target_os = "macos")]
    emitted_names: HashSet<String>,
}

#[napi]
impl DirectoryCursor {
    #[napi]
    pub fn read_page(&mut self, limit: u32) -> Result<MetadataPage> {
        if self.closed {
            return Ok(empty_page(true));
        }
        let safe_limit = clamp_page_limit(limit);
        #[cfg(target_os = "macos")]
        {
            if let Some(names) = self.fallback_names.as_ref() {
                let start = self.fallback_index;
                let end = (start + safe_limit).min(names.len());
                let entries = names[start..end]
                    .iter()
                    .map(|name| metadata_entry(&self.path, name, self.parent_device))
                    .collect::<Vec<_>>();
                self.fallback_index = end;
                return Ok(MetadataPage {
                    done: end == names.len(),
                    bulk_entries: 0,
                    fallback_entries: entries.len() as i64,
                    entries,
                });
            }
            let (names, bulk_error) = fill_requested_names(
                &mut self.pending_bulk,
                &mut self.bulk_done,
                safe_limit,
                || read_bulk_names(self.file.as_raw_fd()),
            );
            let bulk_entries = names.len();
            let mut entries = Vec::with_capacity(safe_limit);
            for name in names {
                self.emitted_names.insert(name.clone());
                entries.push(metadata_entry(&self.path, &name, self.parent_device));
            }
            if bulk_error.is_some() {
                let fallback_names = read_fallback_names(&self.path, &self.emitted_names)?;
                let take = (safe_limit - entries.len()).min(fallback_names.len());
                entries.extend(
                    fallback_names[..take]
                        .iter()
                        .map(|name| metadata_entry(&self.path, name, self.parent_device)),
                );
                self.fallback_index = take;
                self.fallback_names = Some(fallback_names);
                return Ok(MetadataPage {
                    done: self
                        .fallback_names
                        .as_ref()
                        .is_some_and(|fallback| self.fallback_index == fallback.len()),
                    bulk_entries: bulk_entries as i64,
                    fallback_entries: (entries.len() - bulk_entries) as i64,
                    entries,
                });
            }
            let done = self.bulk_done && self.pending_bulk.is_empty();
            return Ok(MetadataPage {
                bulk_entries: bulk_entries as i64,
                fallback_entries: 0,
                entries,
                done,
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = safe_limit;
            Err(Error::from_reason(
                "getattrlistbulk is only available on macOS",
            ))
        }
    }

    #[napi]
    pub fn close(&mut self) {
        self.closed = true;
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
            path: path_buf,
            parent_device: metadata.dev(),
            closed: false,
            file,
            pending_bulk: VecDeque::new(),
            bulk_done: false,
            fallback_names: None,
            fallback_index: 0,
            emitted_names: HashSet::new(),
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

fn fill_requested_names<E>(
    pending: &mut VecDeque<String>,
    done: &mut bool,
    limit: usize,
    mut refill: impl FnMut() -> std::result::Result<Vec<String>, E>,
) -> (Vec<String>, Option<E>) {
    let mut names = Vec::with_capacity(limit);
    while names.len() < limit {
        if let Some(name) = pending.pop_front() {
            names.push(name);
            continue;
        }
        if *done {
            break;
        }
        match refill() {
            Ok(chunk) if chunk.is_empty() => *done = true,
            Ok(chunk) => pending.extend(chunk),
            Err(error) => return (names, Some(error)),
        }
    }
    (names, None)
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
fn read_bulk_names(fd: std::os::unix::io::RawFd) -> Result<Vec<String>> {
    let mut attributes = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_NAME,
        volattr: 0,
        dirattr: 0,
        fileattr: 0,
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
    parse_bulk_names(&buffer, count as usize)
}

#[cfg(target_os = "macos")]
fn parse_bulk_names(buffer: &[u8], count: usize) -> Result<Vec<String>> {
    use std::os::unix::ffi::OsStringExt;
    let mut names = Vec::with_capacity(count);
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
        // Every bulk record starts with its length and attribute_set_t (five u32s),
        // followed by the requested attributes in attrlist order.
        let reference_start = offset + 24;
        let reference_offset = i32::from_ne_bytes(
            buffer[reference_start..reference_start + 4]
                .try_into()
                .unwrap(),
        );
        let reference_length = u32::from_ne_bytes(
            buffer[reference_start + 4..reference_start + 8]
                .try_into()
                .unwrap(),
        ) as usize;
        let data_start = (reference_start as isize + reference_offset as isize) as usize;
        if reference_offset < 0
            || data_start < reference_start + 8
            || data_start >= offset + record_length
            || reference_length == 0
            || data_start + reference_length > offset + record_length
        {
            return Err(Error::from_reason(
                "getattrlistbulk returned an invalid name reference",
            ));
        }
        let bytes = &buffer[data_start..data_start + reference_length];
        let end = bytes
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(bytes.len());
        let name = std::ffi::OsString::from_vec(bytes[..end].to_vec())
            .to_string_lossy()
            .into_owned();
        if name.is_empty() || name == "." || name == ".." {
            return Err(Error::from_reason(
                "getattrlistbulk returned an invalid entry name",
            ));
        }
        names.push(name);
        offset += record_length;
    }
    Ok(names)
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
            vec!["one".to_owned(), "two".to_owned()],
            vec!["three".to_owned(), "four".to_owned()],
        ]);
        let (names, error) = fill_requested_names(&mut pending, &mut done, 3, || {
            Ok::<_, ()>(chunks.pop_front().unwrap_or_default())
        });
        assert!(error.is_none());
        assert_eq!(names, ["one", "two", "three"]);
        assert_eq!(pending, VecDeque::from(["four".to_owned()]));
    }

    #[test]
    fn empty_pages_are_terminal() {
        let page = empty_page(true);
        assert!(page.done);
        assert!(page.entries.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_aligned_bulk_name_records() {
        let mut buffer = vec![0_u8; 80];
        for (offset, name) in [
            (0_usize, b"one\0".as_slice()),
            (40_usize, b"two\0".as_slice()),
        ] {
            buffer[offset..offset + 4].copy_from_slice(&40_u32.to_ne_bytes());
            buffer[offset + 24..offset + 28].copy_from_slice(&8_i32.to_ne_bytes());
            buffer[offset + 28..offset + 32].copy_from_slice(&(name.len() as u32).to_ne_bytes());
            buffer[offset + 32..offset + 32 + name.len()].copy_from_slice(name);
        }
        let names = parse_bulk_names(&buffer, 2).expect("bulk records parse");
        assert_eq!(names, ["one", "two"]);
    }
}
