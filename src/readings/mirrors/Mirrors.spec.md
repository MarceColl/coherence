# Mirrors

The mirror reading: the lists a project keeps by hand that must mirror something defined elsewhere (the defect family hand-list), found by overlap between literal collections and what code derives (a folder's files, the import closure of a list of files, a module's exports, the keys a file reads), explained by git history, read from git objects at one revision, and advisory: on request through query mirrors, and at a session's start from the last reading kept, never one taken in a hook.
model: none — a reading over one revision

## invariants
- reads one revision: The mirror reading reads every file from git objects at one revision, HEAD unless another is asked for, and never the working tree, so an edit not yet committed changes nothing it says and an older revision reads as it was committed.
  over: a fixture repository whose list of files drifts from its import closure in its last commit, read at HEAD with an uncommitted edit that repairs the list, and read at the commit before
  via: the mirror reading reads git objects at its revision: an uncommitted edit leaves it unchanged, and the commit before reads as it was
  because: an agent edits the tree mid-session, and a reading of a half-made edit would name drift the edit is about to repair or miss drift it is about to commit; read at a revision it holds still, and a release can be read as it shipped, which is how the spike measured BROWSER_SOURCES at v1.7.1 and at b37627e (d-577a281e, d-520846aa)
  crossing: project-source -> reading
  refuted: made readAll take each file's text from the working tree instead of the object at the revision -> the totality oracle went red; restored, green (2026-10-12)
  kinds: none
- never computed in a hook: No hook takes the mirror reading: no module the hooks load at run time reaches the reading or the compiler's parser, orient names hand lists only from the last reading kept, labeled with the commit and time it read, and the session start and stop start a new one detached, never waiting on it.
  over: every module the command line and the hook module import at run time, followed to the end, and orient over a kept reading and over none
  via: no hook loads the mirror reading: the hooks' import closure never reaches it or the compiler, and orient reads only the kept reading, labeled with its commit
  because: a tool hook's latency budget is 3 s and the start injection has a fixed budget; the reading takes about a second on Coherence and grows with the project and its history, so a hook that took it would spend its budget on advice (d-520846aa). The label keeps a reading of an older commit from being taken for a reading of the tree now
  crossing: record -> reading
  refuted: imported readMirrors statically into recorded.ts, the module the hooks load for orient -> the totality oracle went red; restored, green (2026-10-12)
  kinds: none
- only strong groups are surfaced: A group is put in front of the agent (orient, and query mirrors by default) only when its sets lie in more than one file, one finding shares three or more names, and it scores 20 or more; every other group is listed only on request, and nothing the reading finds is a spec problem or blocks.
  over: a group beside its source in one file, a two-name group, a group under the score, a group that passes all three, the kept reading, and the default and --all answers
  via: only cross-file groups sharing three or more names and scoring 20 or more are surfaced, and the rest are listed only on request
  because: d-9f7c91c8: at v1.7.2 this cut surfaces 26 of 82 groups, 18 of them hand lists, and 10 of the 16 hand lists the manual sweep found, while two-name groups (5 of 34) and same-file groups (2 of 23) were mostly no mirror. A hand list may be a deliberate subset, so the reading advises and never owes
  refuted: dropped the cross-file condition from surfaced, so a group beside its source in one file was put in front of the agent -> the totality oracle went red; restored, green (2026-10-12)
  kinds: none
- a drifted closure names its commit: A list of files that has drifted from the import closure of its own files, where history names a commit that grew one side alone, is an alarm wherever it ranks, naming the file it lacks and that commit; while the list equals its closure it is latent and no alarm.
  over: a fixture repository whose list of files equals its import closure, then a commit that adds an import of a new file to one of those files and leaves the list alone
  via: a list of files drifted from its own import closure is an alarm naming the missing file and the commit that grew the closure alone
  because: d-9f7c91c8: the one precise shape. BROWSER_SOURCES at v1.7.1 lacked languages-read.ts, and the history pass named b37627e as the one missed commit; the commit is what turns a drift finding into an action, and the pair is the first to promote to a declared mirror
  crossing: project-source -> reading
  refuted: made the history pass never count a new import as growing an import closure, so no commit was named for it -> the totality oracle went red; restored, green (2026-10-12)
  kinds: none
- latent pairs are proposed with one recipe: The reading proposes a declaration for every latent or duplicate finding of a surfaced group and for every alarm, as the list's file, line and name with its universe as one recipe: closure of files, keys of <file>:<name>, or literal at <file>:<line>; a universe no recipe names (a folder, a module's exports, an index's closure) proposes nothing.
  over: a list equal to the closure of its own files, a list copied as another file's object keys, a list copied as another literal, a drifted pair, a pair in a group that is not surfaced, and a list against its folder
  via: latent and duplicate findings of surfaced groups and alarms become proposed pairs with one universe recipe each, and a folder proposes none
  because: d-f1ff87d6: the edit-time alarm watches declared pairs, and this reading is how a pair is found; the declaration format belongs to the alarm, so the reading proposes in one plain shape and declares nothing itself
  refuted: made recipeOf name a folder universe as a literal at its line, so a list against its folder was proposed -> the totality oracle went red; restored, green (2026-10-12)
  kinds: none
