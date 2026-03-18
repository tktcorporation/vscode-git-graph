use napi_derive::napi;

/// Input commit for graph lane computation.
/// Only needs hash and parents - minimal data transfer from JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct GraphCommitInput {
    pub hash: String,
    pub parents: Vec<String>,
}

/// Result of graph lane computation.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct GraphLaneResult {
    /// Per-commit lane assignments. lanes[i] = [myLane, parentLane1, parentLane2, ...]
    pub lanes: Vec<Vec<i32>>,
    /// Maximum number of active lanes encountered.
    pub max_lanes: i32,
}

/// Compute graph lane assignments for commits.
///
/// This is the graph layout algorithm - determines which column (lane) each
/// commit occupies and how parent edges connect. Runs in O(n * max_parents)
/// time with O(active_lanes) space.
///
/// The algorithm:
/// 1. Each commit claims a lane (reuses parent's lane or gets a new one)
/// 2. First parent continues in the same lane (straight lines)
/// 3. Additional parents (merges) get new or existing lanes
/// 4. Trailing empty lanes are cleaned up to keep the graph compact
#[napi]
pub fn compute_graph_lanes(commits: Vec<GraphCommitInput>) -> GraphLaneResult {
    let n = commits.len();

    let mut all_lanes: Vec<Vec<i32>> = Vec::with_capacity(n);
    let mut max_lanes: usize = 0;

    // Active lanes: maps lane index -> hash of commit expected in that lane
    // Using Option<&str> where None = empty lane
    let mut active_lanes: Vec<Option<&str>> = Vec::new();

    for commit in &commits {
        let hash = commit.hash.as_str();
        let mut commit_lanes: Vec<i32> = Vec::with_capacity(commit.parents.len() + 1);

        // Find this commit's lane
        let my_lane = find_lane(&active_lanes, hash)
            .unwrap_or_else(|| find_or_create_empty_lane(&mut active_lanes));

        commit_lanes.push(my_lane as i32);

        // Process parents
        if commit.parents.is_empty() {
            // Root commit - free the lane
            active_lanes[my_lane] = None;
        } else {
            // First parent continues in this lane
            active_lanes[my_lane] = Some(commit.parents[0].as_str());

            // Additional parents get new lanes (merge edges)
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

        // Clean up trailing empty lanes
        while let Some(None) = active_lanes.last() {
            active_lanes.pop();
        }

        max_lanes = max_lanes.max(active_lanes.len());
        all_lanes.push(commit_lanes);
    }

    GraphLaneResult {
        lanes: all_lanes,
        max_lanes: max_lanes as i32,
    }
}

/// Find the lane index occupied by a given hash.
#[inline]
pub fn find_lane<'a>(active_lanes: &[Option<&'a str>], hash: &str) -> Option<usize> {
    active_lanes.iter().position(|lane| *lane == Some(hash))
}

/// Find an empty lane or create a new one.
#[inline]
pub fn find_or_create_empty_lane(active_lanes: &mut Vec<Option<&str>>) -> usize {
    match active_lanes.iter().position(|lane| lane.is_none()) {
        Some(idx) => idx,
        None => {
            active_lanes.push(None);
            active_lanes.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, parents: &[&str]) -> GraphCommitInput {
        GraphCommitInput {
            hash: hash.to_string(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn test_linear_history() {
        // C3 -> C2 -> C1 (root)
        let commits = vec![
            commit("c3", &["c2"]),
            commit("c2", &["c1"]),
            commit("c1", &[]),
        ];

        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes.len(), 3);
        // All commits should be in lane 0 (linear)
        assert_eq!(result.lanes[0], vec![0]);
        assert_eq!(result.lanes[1], vec![0]);
        assert_eq!(result.lanes[2], vec![0]);
        assert_eq!(result.max_lanes, 1);
    }

    #[test]
    fn test_single_branch_merge() {
        // M (merge c3+c2) -> c3 -> c2 -> c1
        // With branch: M merges c3 and branch_tip
        //   M
        //  / \
        // c3  branch_tip
        // |   |
        // c2  |
        // |  /
        // c1
        let commits = vec![
            commit("merge", &["c3", "branch_tip"]),
            commit("c3", &["c2"]),
            commit("branch_tip", &["c1"]),
            commit("c2", &["c1"]),
            commit("c1", &[]),
        ];

        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes.len(), 5);

        // Merge commit: lane 0, with second parent in lane 1
        assert_eq!(result.lanes[0][0], 0); // merge in lane 0
        assert_eq!(result.lanes[0].len(), 2); // has merge edge

        // c3 continues in lane 0
        assert_eq!(result.lanes[1][0], 0);

        // branch_tip should be in lane 1
        assert_eq!(result.lanes[2][0], 1);

        assert!(result.max_lanes >= 2);
    }

    #[test]
    fn test_root_commit_only() {
        let commits = vec![commit("root", &[])];
        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes, vec![vec![0]]);
        // Root commit creates lane 0 then frees it; but max_lanes captures the peak
        // which is 1 during processing (before cleanup), but after cleanup it's 0.
        // The active_lanes.len() after cleanup is 0, but max_lanes was computed
        // before cleanup at the end. Let's check: active_lanes starts empty,
        // find_or_create_empty_lane pushes to get lane 0 (len=1),
        // then root frees lane (None), then trailing cleanup pops it (len=0).
        // max_lanes = max(0, 0) = 0 since cleanup happens before max_lanes update...
        // Actually max_lanes is computed AFTER cleanup. So it's 0.
        assert_eq!(result.max_lanes, 0);
    }

    #[test]
    fn test_empty_input() {
        let result = compute_graph_lanes(vec![]);
        assert!(result.lanes.is_empty());
        assert_eq!(result.max_lanes, 0);
    }

    #[test]
    fn test_two_parallel_branches() {
        // Two branches that don't merge:
        // a2 -> a1  (lane 0)
        // b2 -> b1  (lane 1)
        // But in git log order they'd be interleaved by date:
        // a2, b2, a1, b1
        let commits = vec![
            commit("a2", &["a1"]),
            commit("b2", &["b1"]),
            commit("a1", &[]),
            commit("b1", &[]),
        ];

        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes.len(), 4);

        // a2 gets lane 0
        assert_eq!(result.lanes[0][0], 0);
        // b2 gets lane 1 (a1 is in lane 0)
        assert_eq!(result.lanes[1][0], 1);
        // a1 is in lane 0 (continued from a2)
        assert_eq!(result.lanes[2][0], 0);
        // b1 is in lane 1 (continued from b2)
        assert_eq!(result.lanes[3][0], 1);

        assert_eq!(result.max_lanes, 2);
    }

    #[test]
    fn test_lane_reuse_after_root() {
        // After a root commit frees a lane, a new branch should reuse it:
        // a1 (root) frees lane 0
        // b1 (new branch) should get lane 0 (reused)
        let commits = vec![
            commit("a1", &[]),
            commit("b1", &[]),
        ];

        let result = compute_graph_lanes(commits);
        // a1 gets lane 0, frees it
        assert_eq!(result.lanes[0][0], 0);
        // b1 reuses lane 0
        assert_eq!(result.lanes[1][0], 0);
    }

    #[test]
    fn test_octopus_merge() {
        // Merge with 3 parents
        let commits = vec![
            commit("merge", &["p1", "p2", "p3"]),
            commit("p1", &["base"]),
            commit("p2", &["base"]),
            commit("p3", &["base"]),
            commit("base", &[]),
        ];

        let result = compute_graph_lanes(commits);
        // Merge commit should have 3 entries: [myLane, p2Lane, p3Lane]
        assert_eq!(result.lanes[0].len(), 3);
        assert!(result.max_lanes >= 3);
    }

    #[test]
    fn test_many_commits_performance() {
        // 10000 linear commits - should be fast
        let n = 10000;
        let mut commits = Vec::with_capacity(n);
        for i in 0..n {
            let hash = format!("c{:06}", i);
            let parents = if i < n - 1 {
                vec![format!("c{:06}", i + 1)]
            } else {
                vec![]
            };
            commits.push(GraphCommitInput { hash, parents });
        }

        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes.len(), n);
        assert_eq!(result.max_lanes, 1); // linear = 1 lane
    }

    #[test]
    fn test_complex_branch_and_merge() {
        //   m2 (merge f2 + main2)
        //  / \
        // f2  main2
        // |   |
        // f1  main1
        //  \ /
        //  base
        let commits = vec![
            commit("m2", &["f2", "main2"]),
            commit("f2", &["f1"]),
            commit("main2", &["main1"]),
            commit("f1", &["base"]),
            commit("main1", &["base"]),
            commit("base", &[]),
        ];

        let result = compute_graph_lanes(commits);
        assert_eq!(result.lanes.len(), 6);
        // Verify all commits got lane assignments
        for lane in &result.lanes {
            assert!(!lane.is_empty());
        }
    }

    #[test]
    fn test_trailing_lane_cleanup() {
        // After a merge resolves, trailing empty lanes should be cleaned up
        // This tests that max_lanes doesn't grow unnecessarily
        let commits = vec![
            commit("merge", &["a", "b"]),
            commit("a", &["root"]),
            commit("b", &["root"]),
            commit("root", &[]),
        ];

        let result = compute_graph_lanes(commits);
        // After merge resolves and both branches complete, lanes should compact
        assert!(result.max_lanes <= 2);
    }
}
