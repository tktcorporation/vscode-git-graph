use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::graph::{find_lane, find_or_create_empty_lane};
use crate::parse::parse_git_log_impl;

/// Combined result of parsing + graph lane computation.
/// Doing both in a single native call eliminates JS↔Rust data transfer
/// for the graph computation step.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ParseAndComputeResult {
    /// JSON string of commits array (faster than napi object creation)
    pub commits_json: String,
    /// Per-commit lane assignments
    pub lanes: Vec<Vec<i32>>,
    /// Maximum active lanes
    pub max_lanes: i32,
}

/// Parse git log AND compute graph lanes in a single native call.
/// This is the fastest path - eliminates round-trip overhead between
/// parsing and graph computation.
#[napi]
pub fn parse_and_compute_lanes(raw: String) -> ParseAndComputeResult {
    parse_and_compute_impl(raw.as_bytes())
}

/// Same as parse_and_compute_lanes but accepts a Buffer.
#[napi]
pub fn parse_and_compute_lanes_buffer(raw: Buffer) -> ParseAndComputeResult {
    parse_and_compute_impl(raw.as_ref())
}

fn parse_and_compute_impl(data: &[u8]) -> ParseAndComputeResult {
    let commits = parse_git_log_impl(data);
    let n = commits.len();

    // Compute graph lanes using the parsed data directly
    let mut all_lanes: Vec<Vec<i32>> = Vec::with_capacity(n);
    let mut max_lanes: usize = 0;
    let mut active_lanes: Vec<Option<&str>> = Vec::new();

    for commit in &commits {
        let hash = commit.hash.as_str();
        let mut commit_lanes: Vec<i32> = Vec::with_capacity(commit.parents.len() + 1);

        let my_lane = find_lane(&active_lanes, hash)
            .unwrap_or_else(|| find_or_create_empty_lane(&mut active_lanes));

        commit_lanes.push(my_lane as i32);

        if commit.parents.is_empty() {
            active_lanes[my_lane] = None;
        } else {
            active_lanes[my_lane] = Some(commit.parents[0].as_str());
            for parent_hash in &commit.parents[1..] {
                let parent_lane = find_lane(&active_lanes, parent_hash.as_str())
                    .unwrap_or_else(|| {
                        let lane = find_or_create_empty_lane(&mut active_lanes);
                        active_lanes[lane] = Some(parent_hash.as_str());
                        lane
                    });
                commit_lanes.push(parent_lane as i32);
            }
        }

        while let Some(None) = active_lanes.last() {
            active_lanes.pop();
        }

        max_lanes = max_lanes.max(active_lanes.len());
        all_lanes.push(commit_lanes);
    }

    // Serialize commits to JSON
    let commits_json = crate::parse::commits_to_json(&commits);

    ParseAndComputeResult {
        commits_json,
        lanes: all_lanes,
        max_lanes: max_lanes as i32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIELD_SEP: u8 = 0x00;
    const RECORD_SEP: u8 = 0x01;

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

    fn make_commit(hash: &str, parents: &str) -> Vec<u8> {
        make_record(&[
            hash,
            &hash[..7.min(hash.len())],
            parents,
            "Author",
            "author@test.com",
            "1700000000",
            "Author",
            "author@test.com",
            "1700000000",
            "test commit",
        ])
    }

    #[test]
    fn test_combined_linear() {
        let data = make_log(&[
            make_commit("c3hash0000000000000000000000000000000000", "c2hash0000000000000000000000000000000000"),
            make_commit("c2hash0000000000000000000000000000000000", "c1hash0000000000000000000000000000000000"),
            make_commit("c1hash0000000000000000000000000000000000", ""),
        ]);

        let result = parse_and_compute_impl(&data);

        // Verify lanes (all in lane 0 for linear)
        assert_eq!(result.lanes.len(), 3);
        assert_eq!(result.lanes[0], vec![0]);
        assert_eq!(result.lanes[1], vec![0]);
        assert_eq!(result.lanes[2], vec![0]);
        assert_eq!(result.max_lanes, 1);

        // Verify JSON contains all commits
        assert!(result.commits_json.starts_with('['));
        assert!(result.commits_json.ends_with(']'));
        assert_eq!(result.commits_json.matches("\"hash\"").count(), 3);
    }

    #[test]
    fn test_combined_merge() {
        let data = make_log(&[
            make_commit(
                "merge000000000000000000000000000000000000",
                "c1hash0000000000000000000000000000000000 c2hash0000000000000000000000000000000000",
            ),
            make_commit("c1hash0000000000000000000000000000000000", "root000000000000000000000000000000000000"),
            make_commit("c2hash0000000000000000000000000000000000", "root000000000000000000000000000000000000"),
            make_commit("root000000000000000000000000000000000000", ""),
        ]);

        let result = parse_and_compute_impl(&data);
        assert_eq!(result.lanes.len(), 4);
        assert_eq!(result.lanes[0].len(), 2); // merge has 2 lane entries
        assert!(result.max_lanes >= 2);
    }

    #[test]
    fn test_combined_empty() {
        let result = parse_and_compute_impl(b"");
        assert!(result.lanes.is_empty());
        assert_eq!(result.max_lanes, 0);
        assert_eq!(result.commits_json, "[]");
    }

    #[test]
    fn test_combined_large_history() {
        let n = 5000;
        let mut records = Vec::with_capacity(n);
        for i in 0..n {
            let hash = format!("h{:038}", i);
            let parents = if i < n - 1 {
                format!("h{:038}", i + 1)
            } else {
                String::new()
            };
            records.push(make_commit(&hash, &parents));
        }
        let data = make_log(&records);

        let result = parse_and_compute_impl(&data);
        assert_eq!(result.lanes.len(), n);
        assert_eq!(result.max_lanes, 1); // linear = 1 lane
    }
}
