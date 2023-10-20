/**
  @module @ember-data/store
*/
import { ImmutableRequestInfo } from '@ember-data/request/-private/types';
import { addTransactionCB } from '@ember-data/tracking/-private';

import type { CollectionResourceDocument } from '../../-types/q/ember-data-json-api';
import type { StableRecordIdentifier } from '../../-types/q/identifier';
import IdentifierArray, {
  ARRAY_SIGNAL,
  Collection,
  CollectionCreateOptions,
  NOTIFY,
  notifyArray,
  SOURCE,
} from '../record-arrays/identifier-array';
import type Store from '../store-service';
import { CacheOperation, UnsubscribeToken } from './notification-manager';

const FAKE_ARR = {};
const SLICE_BATCH_SIZE = 1200;
/**
 * This is a clever optimization.
 *
 * clever optimizations rarely stand the test of time, so if you're
 * ever curious or think something better is possible please benchmark
 * and discuss. The benchmark for this at the time of writing is in
 * `scripts/benchmark-push.js`
 *
 * This approach turns out to be 150x faster in Chrome and node than
 * simply using push or concat. It's highly susceptible to the specifics
 * of the batch size, and may require tuning.
 *
 * Clever optimizations should always come with a `why`. This optimization
 * exists for two reasons.
 *
 * 1) array.push(...objects) and Array.prototype.push.apply(arr, objects)
 *   are susceptible to stack overflows. The size of objects at which this
 *   occurs varies by environment, browser, and current stack depth and memory
 *   pressure; however, it occurs in all browsers in fairly pristine conditions
 *   somewhere around 125k to 200k elements. Since EmberData regularly encounters
 *   arrays larger than this in size, we cannot use push.
 *
 * 2) `array.concat` or simply setting the array to a new reference is often an
 *   easier approach; however, native Proxy to an array cannot swap it's target array
 *   and attempts at juggling multiple array sources have proven to be victim to a number
 *   of browser implementation bugs. Should these bugs be addressed then we could
 *   simplify to using `concat`, however, do note this is currently 150x faster
 *   than concat, and due to the overloaded signature of concat will likely always
 *   be faster.
 *
 * Sincerely,
 *   - runspired (Chris Thoburn) 08/21/2022
 *
 * @function fastPush
 * @internal
 * @param target the array to push into
 * @param source the items to push into target
 */
export function fastPush<T>(target: T[], source: T[]) {
  let startLength = 0;
  let newLength = source.length;
  while (newLength - startLength > SLICE_BATCH_SIZE) {
    // eslint-disable-next-line prefer-spread
    target.push.apply(target, source.slice(startLength, startLength + SLICE_BATCH_SIZE));
    startLength += SLICE_BATCH_SIZE;
  }
  // eslint-disable-next-line prefer-spread
  target.push.apply(target, source.slice(startLength));
}

type ChangeSet = Map<StableRecordIdentifier, 'add' | 'del'>;

/**
  @class RecordArrayManager
  @internal
*/
class RecordArrayManager {
  declare store: Store;
  declare isDestroying: boolean;
  declare isDestroyed: boolean;
  declare _set: Map<IdentifierArray, Set<StableRecordIdentifier>>;
  declare _live: Map<string, IdentifierArray>;
  declare _managed: Set<IdentifierArray>;
  declare _pending: Map<IdentifierArray, ChangeSet>;
  declare _identifiers: Map<StableRecordIdentifier, Set<Collection>>;
  declare _staged: Map<string, ChangeSet>;
  declare _subscription: UnsubscribeToken;
  declare _keyedArrays: Map<string, Collection>;
  declare _visibilitySet: Map<StableRecordIdentifier, boolean>;

  constructor(options: { store: Store }) {
    this.store = options.store;
    this.isDestroying = false;
    this.isDestroyed = false;
    this._live = new Map();
    this._managed = new Set();
    this._pending = new Map();
    this._staged = new Map();
    this._keyedArrays = new Map();
    this._identifiers = new Map();
    this._set = new Map();
    this._visibilitySet = new Map();

    this._subscription = this.store.notifications.subscribe(
      'resource',
      (identifier: StableRecordIdentifier, type: CacheOperation) => {
        if (type === 'added') {
          this._visibilitySet.set(identifier, true);
          this.identifierAdded(identifier);
        } else if (type === 'removed') {
          this._visibilitySet.set(identifier, false);
          this.identifierRemoved(identifier);
        } else if (type === 'state') {
          this.identifierChanged(identifier);
        }
      }
    );
  }

  _syncArray(array: IdentifierArray) {
    const pending = this._pending.get(array);

    if (!pending || this.isDestroying || this.isDestroyed) {
      return;
    }

    sync(array, pending, this._set.get(array)!);
    this._pending.delete(array);
  }

  /**
    Get the `RecordArray` for a modelName, which contains all loaded records of
    given modelName.

    @method liveArrayFor
    @internal
    @param {String} modelName
    @return {RecordArray}
  */
  liveArrayFor(type: string): IdentifierArray {
    let array = this._live.get(type);
    let identifiers: StableRecordIdentifier[] = [];
    let staged = this._staged.get(type);
    if (staged) {
      staged.forEach((value, key) => {
        if (value === 'add') {
          identifiers.push(key);
        }
      });
      this._staged.delete(type);
    }

    if (!array) {
      array = new IdentifierArray({
        type,
        identifiers,
        store: this.store,
        allowMutation: false,
        manager: this,
      });
      this._live.set(type, array);
      this._set.set(array, new Set(identifiers));
    }

    return array;
  }

  createArray(config: {
    type?: string;
    query?: ImmutableRequestInfo | Record<string, unknown>;
    identifiers?: StableRecordIdentifier[];
    doc?: CollectionResourceDocument;
  }): Collection {
    let options: CollectionCreateOptions = {
      type: config.type,
      links: config.doc?.links || null,
      meta: config.doc?.meta || null,
      query: config.query || null,
      identifiers: config.identifiers || [],
      isLoaded: !!config.identifiers?.length,
      allowMutation: false,
      store: this.store,
      manager: this,
    };
    let array = new Collection(options);
    this._managed.add(array);
    this._set.set(array, new Set(options.identifiers || []));
    if (config.identifiers) {
      associate(this._identifiers, array, config.identifiers);
    }

    return array;
  }

  dirtyArray(array: IdentifierArray, delta: number): void {
    if (array === FAKE_ARR) {
      return;
    }
    let tag = array[ARRAY_SIGNAL];
    if (!tag.shouldReset) {
      tag.shouldReset = true;
      addTransactionCB(array[NOTIFY]);
    } else if (delta > 0 && !tag.t) {
      addTransactionCB(array[NOTIFY]);
    }
  }

  _getPendingFor(
    identifier: StableRecordIdentifier,
    includeManaged: boolean,
    isRemove?: boolean
  ): Map<IdentifierArray, ChangeSet> | void {
    if (this.isDestroying || this.isDestroyed) {
      return;
    }

    let liveArray = this._live.get(identifier.type);
    const allPending = this._pending;
    let pending: Map<IdentifierArray, ChangeSet> = new Map();

    if (includeManaged) {
      let managed = this._identifiers.get(identifier);
      if (managed) {
        managed.forEach((arr) => {
          let changes = allPending.get(arr);
          if (!changes) {
            changes = new Map();
            allPending.set(arr, changes);
          }
          pending.set(arr, changes);
        });
      }
    }

    // during unloadAll we can ignore removes since we've already
    // cleared the array.
    if (liveArray && liveArray[SOURCE].length === 0 && isRemove) {
      const pendingLive = allPending.get(liveArray);
      if (!pendingLive || pendingLive.size === 0) {
        return pending;
      }
    }

    if (!liveArray) {
      // start building a changeset for when we eventually
      // do have a live array
      let changes = this._staged.get(identifier.type);
      if (!changes) {
        changes = new Map();
        this._staged.set(identifier.type, changes);
      }
      pending.set(FAKE_ARR as IdentifierArray, changes);
    } else {
      let changes = allPending.get(liveArray);
      if (!changes) {
        changes = new Map();
        allPending.set(liveArray, changes);
      }
      pending.set(liveArray, changes);
    }

    return pending;
  }

  populateManagedArray(array: Collection, identifiers: StableRecordIdentifier[], payload: CollectionResourceDocument) {
    this._pending.delete(array);
    const source = array[SOURCE];
    const old = source.slice();
    source.length = 0;
    fastPush(source, identifiers);
    this._set.set(array, new Set(identifiers));

    notifyArray(array);
    array.meta = payload.meta || null;
    array.links = payload.links || null;
    array.isLoaded = true;

    disassociate(this._identifiers, array, old);
    associate(this._identifiers, array, identifiers);
  }

  identifierAdded(identifier: StableRecordIdentifier): void {
    let changeSets = this._getPendingFor(identifier, false);
    if (changeSets) {
      changeSets.forEach((changes, array) => {
        let existing = changes.get(identifier);
        if (existing === 'del') {
          changes.delete(identifier);
        } else {
          changes.set(identifier, 'add');

          this.dirtyArray(array, changes.size);
        }
      });
    }
  }

  identifierRemoved(identifier: StableRecordIdentifier): void {
    let changeSets = this._getPendingFor(identifier, true, true);
    if (changeSets) {
      changeSets.forEach((changes, array) => {
        let existing = changes.get(identifier);
        if (existing === 'add') {
          changes.delete(identifier);
        } else {
          changes.set(identifier, 'del');

          this.dirtyArray(array, changes.size);
        }
      });
    }
  }

  identifierChanged(identifier: StableRecordIdentifier): void {
    let newState = this.store._instanceCache.recordIsLoaded(identifier, true);

    // if the change matches the most recent direct added/removed
    // state, then we can ignore it
    if (this._visibilitySet.get(identifier) === newState) {
      return;
    }

    if (newState) {
      this.identifierAdded(identifier);
    } else {
      this.identifierRemoved(identifier);
    }
  }

  clear(isClear = true) {
    this._live.forEach((array) => array.destroy(isClear));
    this._managed.forEach((array) => array.destroy(isClear));
    this._managed.clear();
    this._identifiers.clear();
    this._pending.clear();
    this._set.forEach((set) => set.clear());
    this._visibilitySet.clear();
  }

  destroy() {
    this.isDestroying = true;
    this.clear(false);
    this._live.clear();
    this.isDestroyed = true;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.store.notifications.unsubscribe(this._subscription);
  }
}

function associate(
  ArraysCache: Map<StableRecordIdentifier, Set<Collection>>,
  array: Collection,
  identifiers: StableRecordIdentifier[]
) {
  for (let i = 0; i < identifiers.length; i++) {
    let identifier = identifiers[i];
    let cache = ArraysCache.get(identifier);
    if (!cache) {
      cache = new Set();
      ArraysCache.set(identifier, cache);
    }
    cache.add(array);
  }
}

function disassociate(
  ArraysCache: Map<StableRecordIdentifier, Set<Collection>>,
  array: Collection,
  identifiers: StableRecordIdentifier[]
) {
  for (let i = 0; i < identifiers.length; i++) {
    disassociateIdentifier(ArraysCache, array, identifiers[i]);
  }
}

export function disassociateIdentifier(
  ArraysCache: Map<StableRecordIdentifier, Set<Collection>>,
  array: Collection,
  identifier: StableRecordIdentifier
) {
  let cache = ArraysCache.get(identifier);
  if (cache) {
    cache.delete(array);
  }
}

function sync(
  array: IdentifierArray,
  changes: Map<StableRecordIdentifier, 'add' | 'del'>,
  arraySet: Set<StableRecordIdentifier>
) {
  let state = array[SOURCE];
  const adds: StableRecordIdentifier[] = [];
  const removes: StableRecordIdentifier[] = [];
  changes.forEach((value, key) => {
    if (value === 'add') {
      // likely we want to keep a Set along-side
      if (arraySet.has(key)) {
        return;
      }
      adds.push(key);
      arraySet.add(key);
    } else {
      if (arraySet.has(key)) {
        removes.push(key);
        arraySet.delete(key);
      }
    }
  });
  if (removes.length) {
    if (removes.length === state.length) {
      state.length = 0;
      // changing the reference breaks the Proxy
      // state = array[SOURCE] = [];
    } else {
      removes.forEach((i) => {
        const index = state.indexOf(i);
        if (index !== -1) {
          state.splice(index, 1);
          arraySet.delete(i);
        }
      });
    }
  }

  if (adds.length) {
    fastPush(state, adds);
    // changing the reference breaks the Proxy
    // else we could do this
    /*
    if (state.length === 0) {
      array[SOURCE] = adds;
    } else {
      array[SOURCE] = state.concat(adds);
    }
    */
  }
}

export default RecordArrayManager;
