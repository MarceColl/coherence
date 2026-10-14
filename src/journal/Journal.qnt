// The work-order lifecycle (src/journal/workVerbs.ts), as guarded actions over pure updates.
//
// Every action is a thin wrapper: its guards, then one conformance fact (the
// order's state or owner after the action, as the code folds its store), then
// one update through a pure function. step supplies each fact as a singleton
// choice, so simulation pays nothing for it, and conformance replay pins it to
// the value the code logged. Every guard is total: it reads an order through
// stateOf and ownerOf, never Map.get on an id that may be absent.
module Journal {
  type Order = { state: str, owner: str }

  // Every order, by id.
  var orders: str -> Order
  // The state each order ended in, set once when it first becomes completed or cancelled; terminalNeverMoves reads it.
  var ended: str -> str

  pure val WORK_STATES = Set("open", "active", "waiting", "completed", "cancelled")
  pure val TERMINAL = Set("completed", "cancelled")
  // What work move takes: every state but completed, which only close records.
  pure val MOVE_STATES = Set("open", "active", "waiting", "cancelled")

  pure def stateOf(os: str -> Order, id: str): str = if (os.keys().contains(id)) os.get(id).state else "none"
  pure def ownerOf(os: str -> Order, id: str): str = if (os.keys().contains(id)) os.get(id).owner else ""
  pure def isLive(os: str -> Order, id: str): bool = os.keys().contains(id) and not(TERMINAL.contains(stateOf(os, id)))

  pure def created(os: str -> Order, id: str, owner: str): str -> Order = os.put(id, { state: "open", owner: owner })
  pure def moved(os: str -> Order, id: str, target: str): str -> Order =
    if (os.keys().contains(id)) os.put(id, { state: target, owner: ownerOf(os, id) }) else os
  pure def reowned(os: str -> Order, id: str, owner: str): str -> Order =
    if (os.keys().contains(id)) os.put(id, { state: stateOf(os, id), owner: owner }) else os
  // The ended map after an update: an order seen terminal for the first time keeps that state.
  pure def ending(e: str -> str, os: str -> Order, id: str): str -> str =
    if (TERMINAL.contains(stateOf(os, id)) and not(e.keys().contains(id))) e.put(id, stateOf(os, id)) else e

  action init = all { orders' = Map(), ended' = Map() }

  // work create: a new id, open, owned by the session it names.
  action create(id: str, owner: str, state_after: str): bool = all {
    not(orders.keys().contains(id)),
    owner != "",
    state_after == stateOf(created(orders, id, owner), id),
    orders' = created(orders, id, owner),
    ended' = ending(ended, created(orders, id, owner), id),
  }

  // work move: an order that exists and has not ended, to a state move takes, never the one it is in.
  action move(id: str, target: str, state_after: str): bool = all {
    orders.keys().contains(id),
    MOVE_STATES.contains(target),
    isLive(orders, id),
    stateOf(orders, id) != target,
    state_after == stateOf(moved(orders, id, target), id),
    orders' = moved(orders, id, target),
    ended' = ending(ended, moved(orders, id, target), id),
  }

  // work close: an order that exists and has not ended, to completed.
  action close(id: str, state_after: str): bool = all {
    orders.keys().contains(id),
    isLive(orders, id),
    state_after == stateOf(moved(orders, id, "completed"), id),
    orders' = moved(orders, id, "completed"),
    ended' = ending(ended, moved(orders, id, "completed"), id),
  }

  // work owner: an order that exists and has not ended, to an owner it does not have.
  action owner(id: str, next_owner: str, owner_after: str): bool = all {
    orders.keys().contains(id),
    isLive(orders, id),
    ownerOf(orders, id) != next_owner,
    next_owner != "",
    owner_after == ownerOf(reowned(orders, id, next_owner), id),
    orders' = reowned(orders, id, next_owner),
    ended' = ended,
  }

  pure val IDS = Set("w1", "w2", "w3")
  pure val SESSIONS = Set("s1", "s2")
  // Every state a caller may name, and one the code refuses.
  pure val NAMED = WORK_STATES.union(Set("done"))

  action step = any {
    nondet id = IDS.oneOf()
    nondet who = SESSIONS.oneOf()
    nondet after = Set(stateOf(created(orders, id, who), id)).oneOf()
    create(id, who, after),
    nondet id = IDS.oneOf()
    nondet target = NAMED.oneOf()
    nondet after = Set(stateOf(moved(orders, id, target), id)).oneOf()
    move(id, target, after),
    nondet id = IDS.oneOf()
    nondet after = Set(stateOf(moved(orders, id, "completed"), id)).oneOf()
    close(id, after),
    nondet id = IDS.oneOf()
    nondet who = SESSIONS.oneOf()
    nondet after = Set(ownerOf(reowned(orders, id, who), id)).oneOf()
    owner(id, who, after),
  }

  // A completed or cancelled order never moves: it stays in the state it ended in.
  val terminalNeverMoves = ended.keys().forall(id => stateOf(orders, id) == ended.get(id))
  // Every order is in one of the five work states.
  val statesKnown = orders.keys().forall(id => WORK_STATES.contains(stateOf(orders, id)))
  // Every order is owned by a named session.
  val ownerNamed = orders.keys().forall(id => ownerOf(orders, id) != "")
  // Completed is reached only through close, so an order that ended completed was live before it.
  val endedKnown = ended.keys().forall(id => TERMINAL.contains(ended.get(id)))

  // The moments of the lifecycle a test should reach; a behavior family is the order they first fire in.
  val landmark_open = orders.keys().exists(id => stateOf(orders, id) == "open")
  val landmark_active = orders.keys().exists(id => stateOf(orders, id) == "active")
  val landmark_waiting = orders.keys().exists(id => stateOf(orders, id) == "waiting")
  val landmark_completed = orders.keys().exists(id => stateOf(orders, id) == "completed")
  val landmark_cancelled = orders.keys().exists(id => stateOf(orders, id) == "cancelled")
}
