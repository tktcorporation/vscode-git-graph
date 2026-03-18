use napi::bindgen_prelude::*;
use napi_derive::napi;

/// A parsed git commit returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeGitCommit {
    pub hash: String,
    pub abbreviated_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    pub author_date: i64,
    pub committer: String,
    pub committer_email: String,
    pub committer_date: i64,
    pub message: String,
}

/// A parsed branch returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeBranch {
    pub name: String,
    pub hash: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub remote: Option<String>,
    pub refname: String,
}

/// A parsed stash entry returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct NativeStash {
    pub hash: String,
    pub selector: String,
    pub message: String,
    pub date: i64,
}

const FIELD_SEP: u8 = 0x00;
const RECORD_SEP: u8 = 0x01;

/// Parse raw git log output (using \x00 field sep and \x01 record sep) into commit objects.
/// This is the hot path - called for every graph load.
#[napi]
pub fn parse_git_log(raw: String) -> Vec<NativeGitCommit> {
    parse_git_log_impl(raw.as_bytes())
}

/// Parse raw git log output from a Buffer for zero-copy performance.
#[napi]
pub fn parse_git_log_buffer(raw: Buffer) -> Vec<NativeGitCommit> {
    parse_git_log_impl(raw.as_ref())
}

/// Parse git log and return as JSON string - avoids napi object creation overhead.
/// For large datasets, returning JSON is faster than creating individual JS objects.
#[napi]
pub fn parse_git_log_json(raw: String) -> String {
    let commits = parse_git_log_impl(raw.as_bytes());
    commits_to_json(&commits)
}

/// Parse git log from Buffer and return as JSON string.
#[napi]
pub fn parse_git_log_buffer_json(raw: Buffer) -> String {
    let commits = parse_git_log_impl(raw.as_ref());
    commits_to_json(&commits)
}

pub fn commits_to_json(commits: &[NativeGitCommit]) -> String {
    let mut json = String::with_capacity(commits.len() * 256);
    json.push('[');
    for (i, c) in commits.iter().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json.push_str("{\"hash\":\"");
        json_escape_into(&mut json, &c.hash);
        json.push_str("\",\"abbreviatedHash\":\"");
        json_escape_into(&mut json, &c.abbreviated_hash);
        json.push_str("\",\"parents\":[");
        for (j, p) in c.parents.iter().enumerate() {
            if j > 0 {
                json.push(',');
            }
            json.push('"');
            json_escape_into(&mut json, p);
            json.push('"');
        }
        json.push_str("],\"author\":\"");
        json_escape_into(&mut json, &c.author);
        json.push_str("\",\"authorEmail\":\"");
        json_escape_into(&mut json, &c.author_email);
        json.push_str("\",\"authorDate\":");
        json.push_str(&c.author_date.to_string());
        json.push_str(",\"committer\":\"");
        json_escape_into(&mut json, &c.committer);
        json.push_str("\",\"committerEmail\":\"");
        json_escape_into(&mut json, &c.committer_email);
        json.push_str("\",\"committerDate\":");
        json.push_str(&c.committer_date.to_string());
        json.push_str(",\"message\":\"");
        json_escape_into(&mut json, &c.message);
        json.push_str("\",\"refs\":[]}");
    }
    json.push(']');
    json
}

fn json_escape_into(buf: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                buf.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => buf.push(c),
        }
    }
}

pub fn parse_git_log_impl(data: &[u8]) -> Vec<NativeGitCommit> {
    // Pre-count records for capacity hint
    let record_count = bytecount(data, RECORD_SEP);
    let mut commits = Vec::with_capacity(record_count);

    for record in data.split(|&b| b == RECORD_SEP) {
        let record = trim_bytes(record);
        if record.is_empty() {
            continue;
        }

        if let Some(commit) = parse_commit_record(record) {
            commits.push(commit);
        }
    }

    commits
}

fn parse_commit_record(record: &[u8]) -> Option<NativeGitCommit> {
    let fields: Vec<&[u8]> = record.split(|&b| b == FIELD_SEP).collect();
    if fields.len() < 10 {
        return None;
    }

    let parents_str = to_str(fields[2]);
    let parents = if parents_str.is_empty() {
        Vec::new()
    } else {
        parents_str.split(' ').map(String::from).collect()
    };

    Some(NativeGitCommit {
        hash: to_string(fields[0]),
        abbreviated_hash: to_string(fields[1]),
        parents,
        author: to_string(fields[3]),
        author_email: to_string(fields[4]),
        author_date: parse_i64(fields[5]),
        committer: to_string(fields[6]),
        committer_email: to_string(fields[7]),
        committer_date: parse_i64(fields[8]),
        message: to_string(fields[9]),
    })
}

/// Parse for-each-ref output into branch objects.
/// Format: name\x00hash\x00HEAD\x00upstream\x00refname
#[napi]
pub fn parse_branches(raw: String) -> Vec<NativeBranch> {
    let mut branches = Vec::new();

    for line in raw.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 5 {
            continue;
        }

        let refname = parts[4];
        let is_remote = refname.starts_with("refs/remotes/");
        let name = parts[0];

        // Skip HEAD pointer in remotes
        if is_remote && name.ends_with("/HEAD") {
            continue;
        }

        let remote = if is_remote {
            name.split('/').next().map(String::from)
        } else {
            None
        };

        let upstream = if parts[3].is_empty() {
            None
        } else {
            Some(parts[3].to_string())
        };

        branches.push(NativeBranch {
            name: name.to_string(),
            hash: parts[1].to_string(),
            current: parts[2] == "*",
            upstream,
            remote,
            refname: refname.to_string(),
        });
    }

    branches
}

/// Parse stash list output.
/// Format: hash\x00selector\x00message\x00date
#[napi]
pub fn parse_stashes(raw: String) -> Vec<NativeStash> {
    let mut stashes = Vec::new();

    for line in raw.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split('\0').collect();
        if parts.len() < 4 {
            continue;
        }

        stashes.push(NativeStash {
            hash: parts[0].to_string(),
            selector: parts[1].to_string(),
            message: parts[2].to_string(),
            date: parts[3].parse::<i64>().unwrap_or(0),
        });
    }

    stashes
}

// ---- Helpers ----

#[inline]
fn to_str(bytes: &[u8]) -> &str {
    std::str::from_utf8(bytes).unwrap_or("")
}

#[inline]
fn to_string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[inline]
fn parse_i64(bytes: &[u8]) -> i64 {
    to_str(bytes).parse::<i64>().unwrap_or(0)
}

#[inline]
fn trim_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|&b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|&b| !b.is_ascii_whitespace()).map_or(start, |p| p + 1);
    &bytes[start..end]
}

#[inline]
fn bytecount(data: &[u8], needle: u8) -> usize {
    data.iter().filter(|&&b| b == needle).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(fields: &[&str]) -> Vec<u8> {
        let mut record = Vec::new();
        for (i, field) in fields.iter().enumerate() {
            if i > 0 {
                record.push(FIELD_SEP);
            }
            record.extend_from_slice(field.as_bytes());
        }
        record
    }

    fn make_log(records: &[Vec<u8>]) -> Vec<u8> {
        let mut data = Vec::new();
        for (i, record) in records.iter().enumerate() {
            if i > 0 {
                data.push(RECORD_SEP);
            }
            data.extend_from_slice(record);
        }
        data
    }

    #[test]
    fn test_parse_single_commit() {
        let record = make_record(&[
            "abc123def456abc123def456abc123def456abc123",
            "abc123d",
            "parent1hash parent2hash",
            "John Doe",
            "john@example.com",
            "1700000000",
            "Jane Smith",
            "jane@example.com",
            "1700000001",
            "feat: add feature",
        ]);

        let commit = parse_commit_record(&record).unwrap();
        assert_eq!(commit.hash, "abc123def456abc123def456abc123def456abc123");
        assert_eq!(commit.abbreviated_hash, "abc123d");
        assert_eq!(commit.parents, vec!["parent1hash", "parent2hash"]);
        assert_eq!(commit.author, "John Doe");
        assert_eq!(commit.author_email, "john@example.com");
        assert_eq!(commit.author_date, 1700000000);
        assert_eq!(commit.committer, "Jane Smith");
        assert_eq!(commit.committer_email, "jane@example.com");
        assert_eq!(commit.committer_date, 1700000001);
        assert_eq!(commit.message, "feat: add feature");
    }

    #[test]
    fn test_parse_root_commit_no_parents() {
        let record = make_record(&[
            "abc123def456abc123def456abc123def456abc123",
            "abc123d",
            "", // no parents
            "John Doe",
            "john@example.com",
            "1700000000",
            "Jane Smith",
            "jane@example.com",
            "1700000001",
            "Initial commit",
        ]);

        let commit = parse_commit_record(&record).unwrap();
        assert!(commit.parents.is_empty());
        assert_eq!(commit.message, "Initial commit");
    }

    #[test]
    fn test_parse_multiple_commits() {
        let r1 = make_record(&[
            "hash1111111111111111111111111111111111111111",
            "hash111",
            "",
            "Alice",
            "alice@test.com",
            "1000000",
            "Alice",
            "alice@test.com",
            "1000000",
            "first commit",
        ]);
        let r2 = make_record(&[
            "hash2222222222222222222222222222222222222222",
            "hash222",
            "hash1111111111111111111111111111111111111111",
            "Bob",
            "bob@test.com",
            "1000001",
            "Bob",
            "bob@test.com",
            "1000001",
            "second commit",
        ]);

        let data = make_log(&[r1, r2]);
        let commits = parse_git_log_impl(&data);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].message, "first commit");
        assert_eq!(commits[1].message, "second commit");
        assert_eq!(
            commits[1].parents,
            vec!["hash1111111111111111111111111111111111111111"]
        );
    }

    #[test]
    fn test_parse_empty_input() {
        let commits = parse_git_log_impl(b"");
        assert!(commits.is_empty());
    }

    #[test]
    fn test_parse_malformed_record_too_few_fields() {
        let record = b"hash\x00abbrev\x00parents";
        let commit = parse_commit_record(record);
        assert!(commit.is_none());
    }

    #[test]
    fn test_parse_invalid_timestamp() {
        let record = make_record(&[
            "hash1111111111111111111111111111111111111111",
            "hash111",
            "",
            "Alice",
            "alice@test.com",
            "not_a_number",
            "Alice",
            "alice@test.com",
            "also_not",
            "msg",
        ]);
        let commit = parse_commit_record(&record).unwrap();
        assert_eq!(commit.author_date, 0);
        assert_eq!(commit.committer_date, 0);
    }

    #[test]
    fn test_parse_commit_with_unicode() {
        let record = make_record(&[
            "hash1111111111111111111111111111111111111111",
            "hash111",
            "",
            "太郎 山田",
            "taro@example.jp",
            "1700000000",
            "太郎 山田",
            "taro@example.jp",
            "1700000000",
            "日本語のコミットメッセージ 🎉",
        ]);
        let commit = parse_commit_record(&record).unwrap();
        assert_eq!(commit.author, "太郎 山田");
        assert_eq!(commit.message, "日本語のコミットメッセージ 🎉");
    }

    #[test]
    fn test_parse_branches_basic() {
        let raw = "main\0abc1234\0*\0origin/main\0refs/heads/main\n\
                    feature\0def5678\0 \0\0refs/heads/feature\n\
                    origin/main\0abc1234\0 \0\0refs/remotes/origin/main\n";
        let branches = parse_branches(raw.to_string());
        assert_eq!(branches.len(), 3);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
        assert_eq!(branches[0].upstream, Some("origin/main".into()));
        assert!(branches[0].remote.is_none());
        assert_eq!(branches[1].name, "feature");
        assert!(!branches[1].current);
        assert!(branches[1].upstream.is_none());
        assert_eq!(branches[2].name, "origin/main");
        assert_eq!(branches[2].remote, Some("origin".into()));
    }

    #[test]
    fn test_parse_branches_skips_remote_head() {
        let raw = "origin/HEAD\0abc1234\0 \0\0refs/remotes/origin/HEAD\n";
        let branches = parse_branches(raw.to_string());
        assert!(branches.is_empty());
    }

    #[test]
    fn test_parse_stashes() {
        let raw = "hash123\0stash@{0}\0WIP on main\01700000000\n\
                    hash456\0stash@{1}\0autosave\01700000100\n";
        let stashes = parse_stashes(raw.to_string());
        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].hash, "hash123");
        assert_eq!(stashes[0].selector, "stash@{0}");
        assert_eq!(stashes[0].message, "WIP on main");
        assert_eq!(stashes[0].date, 1700000000);
    }

    #[test]
    fn test_parse_log_with_whitespace_between_records() {
        let r1 = make_record(&[
            "hash1111111111111111111111111111111111111111",
            "h1",
            "",
            "A",
            "a@b",
            "1",
            "A",
            "a@b",
            "1",
            "m1",
        ]);
        let mut data = r1;
        data.push(RECORD_SEP);
        data.extend_from_slice(b"  \n  "); // whitespace-only record
        data.push(RECORD_SEP);
        let r2 = make_record(&[
            "hash2222222222222222222222222222222222222222",
            "h2",
            "",
            "B",
            "b@c",
            "2",
            "B",
            "b@c",
            "2",
            "m2",
        ]);
        data.extend_from_slice(&r2);

        let commits = parse_git_log_impl(&data);
        assert_eq!(commits.len(), 2);
    }

    #[test]
    fn test_parse_octopus_merge() {
        // A commit with 3 parents (octopus merge)
        let record = make_record(&[
            "hash1111111111111111111111111111111111111111",
            "hash111",
            "parent1 parent2 parent3",
            "Alice",
            "alice@test.com",
            "1700000000",
            "Alice",
            "alice@test.com",
            "1700000000",
            "Merge branches",
        ]);
        let commit = parse_commit_record(&record).unwrap();
        assert_eq!(commit.parents.len(), 3);
        assert_eq!(commit.parents[0], "parent1");
        assert_eq!(commit.parents[1], "parent2");
        assert_eq!(commit.parents[2], "parent3");
    }
}
