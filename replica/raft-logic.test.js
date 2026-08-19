const {
  majorityNeeded,
  isLogUpToDate,
  shouldGrantVote,
  prevLogMatches,
  isDuplicateEntry,
} = require("./raft-logic");

describe("majorityNeeded", () => {
  test("needs 2 votes in a 3-node cluster (2 peers)", () => {
    expect(majorityNeeded(2)).toBe(2);
  });

  test("needs 1 vote in a 1-node cluster (0 peers)", () => {
    expect(majorityNeeded(0)).toBe(1);
  });

  test("needs 3 votes in a 5-node cluster (4 peers)", () => {
    expect(majorityNeeded(4)).toBe(3);
  });
});

describe("isLogUpToDate", () => {
  test("candidate with a higher last term is up to date", () => {
    expect(isLogUpToDate(3, 0, 2, 5)).toBe(true);
  });

  test("candidate with a lower last term is not up to date", () => {
    expect(isLogUpToDate(1, 10, 2, 5)).toBe(false);
  });

  test("same term, candidate needs an index at least as large", () => {
    expect(isLogUpToDate(2, 5, 2, 5)).toBe(true);
    expect(isLogUpToDate(2, 4, 2, 5)).toBe(false);
  });
});

describe("shouldGrantVote", () => {
  const base = { term: 3, currentTerm: 3, logUpToDate: true, votedFor: null, candidateId: "replica2" };

  test("grants vote when term matches, log is current, and no prior vote", () => {
    expect(shouldGrantVote(base)).toBe(true);
  });

  test("denies vote for a stale term", () => {
    expect(shouldGrantVote({ ...base, term: 2 })).toBe(false);
  });

  test("denies vote when the candidate's log is behind", () => {
    expect(shouldGrantVote({ ...base, logUpToDate: false })).toBe(false);
  });

  test("denies vote if already voted for a different candidate this term", () => {
    expect(shouldGrantVote({ ...base, votedFor: "replica3" })).toBe(false);
  });

  test("grants vote again for the same candidate already voted for", () => {
    expect(shouldGrantVote({ ...base, votedFor: "replica2" })).toBe(true);
  });
});

describe("prevLogMatches", () => {
  const log = [{ term: 1, index: 0 }, { term: 2, index: 1 }];

  test("no previous entry expected (prevLogIndex -1) always matches", () => {
    expect(prevLogMatches(log, -1, 0)).toBe(true);
  });

  test("matches when the term at prevLogIndex agrees", () => {
    expect(prevLogMatches(log, 1, 2)).toBe(true);
  });

  test("fails when the term at prevLogIndex disagrees", () => {
    expect(prevLogMatches(log, 1, 99)).toBe(false);
  });

  test("fails when prevLogIndex is beyond the end of the log", () => {
    expect(prevLogMatches(log, 5, 2)).toBe(false);
  });
});

describe("isDuplicateEntry", () => {
  const log = [{ term: 1, index: 0 }, { term: 2, index: 1 }];

  test("detects an already-applied entry", () => {
    expect(isDuplicateEntry(log, { term: 2, index: 1 })).toBe(true);
  });

  test("does not flag a new entry past the end of the log", () => {
    expect(isDuplicateEntry(log, { term: 3, index: 2 })).toBe(false);
  });

  test("does not flag an entry whose term conflicts (needs truncation, not a duplicate)", () => {
    expect(isDuplicateEntry(log, { term: 9, index: 1 })).toBe(false);
  });
});
