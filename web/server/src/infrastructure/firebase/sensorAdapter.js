import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  child, get, runTransaction, getDatabase, ref, query, orderByKey,
  startAt, startAfter, endBefore, limitToFirst, limitToLast,
  onChildAdded, onChildChanged, onValue,
} from 'firebase/database';
import { timeToPushPrefix } from '../../domain/readings.js';

// SDK mechanics only. The store owns references, read deadlines, cancellation,
// subscriptions and all synchronization/cache state. Construction does no I/O.
export function createSensorAdapter({ readSnapshot = get, transaction = runTransaction,
  realtime = { onChildAdded, onChildChanged, onValue } } = {}) {
  return {
    readSnapshot,
    realtime,
    initialize: (config) => initializeApp(config),
    authenticate: (app) => signInAnonymously(getAuth(app)),
    auth: (app) => getAuth(app),
    reference: (app, path) => ref(getDatabase(app), path),
    childReference: (parent, path) => child(parent, path),
    dispose: (app) => deleteApp(app),
    transaction: (parent, id, update) => transaction(child(parent, id), update, { applyLocally: false }),

    subscribe({ dataRef, aggregateRef, realtime: listeners = realtime, unsubscribers,
      onRaw, onSummary, onConnection, onCancel }) {
      unsubscribers.push(listeners.onChildAdded(query(dataRef, orderByKey(), limitToLast(50)), onRaw, onCancel));
      if (aggregateRef) {
        unsubscribers.push(listeners.onChildChanged(query(dataRef, orderByKey(), limitToLast(50)), onRaw, onCancel));
        // Bucket keys are not creation cursors; inventory reconciles old additions.
        const summaries = query(aggregateRef, orderByKey(), limitToLast(1));
        unsubscribers.push(listeners.onChildAdded(summaries, onSummary, onCancel));
        unsubscribers.push(listeners.onChildChanged(summaries, onSummary, onCancel));
        // Raw limit-window removals are eviction, not proof of deletion.
      }
      unsubscribers.push(listeners.onValue(child(dataRef.root, '.info/connected'), onConnection, onCancel));
    },

    recentPageQuery(dataRef, { cursor, lower, upper, limit }) {
      return query(dataRef, orderByKey(), cursor ? startAfter(cursor) : startAt(lower), endBefore(upper), limitToFirst(limit));
    },

    rawPageQuery(dataRef, { from, to, after, limit, reverse = false }) {
      const constraints = [orderByKey()];
      if (reverse) {
        if (from !== undefined) constraints.push(startAt(timeToPushPrefix(from)));
        if (after) constraints.push(endBefore(after));
        else if (to !== undefined) constraints.push(endBefore(timeToPushPrefix(to)));
      } else {
        if (after) constraints.push(startAfter(after));
        else if (from !== undefined) constraints.push(startAt(timeToPushPrefix(from)));
        if (to !== undefined) constraints.push(endBefore(timeToPushPrefix(to)));
      }
      constraints.push(reverse ? limitToLast(limit) : limitToFirst(limit));
      return query(dataRef, ...constraints);
    },

    historyPageQuery(dataRef, { from, to, cursor, reverse = false, limit }) {
      const constraints = [orderByKey()];
      if (from !== undefined) constraints.push(startAt(timeToPushPrefix(from)));
      if (to !== undefined) constraints.push(endBefore(timeToPushPrefix(to + 1)));
      if (cursor) {
        // RTDB permits only one bound on each side.
        const index = reverse ? (to !== undefined ? constraints.length - 1 : -1) : (from !== undefined ? 1 : -1);
        if (index >= 0) constraints.splice(index, 1);
        constraints.push(reverse ? endBefore(cursor) : startAfter(cursor));
      }
      constraints.push(reverse ? limitToLast(limit) : limitToFirst(limit));
      return query(dataRef, ...constraints);
    },
  };
}
