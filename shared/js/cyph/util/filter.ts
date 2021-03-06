import {Observable} from 'rxjs';
import {filter} from 'rxjs/operators';
import {MaybePromise} from '../maybe-promise-type';
import {compareValues} from './compare';


/** Filters asynchronously. */
export const filterAsync				=
	async <T> (arr: T[], f: (value: T) => MaybePromise<boolean>) : Promise<T[]> =>
		(await Promise.all(arr.map(async value => ({filter: await f(value), value})))).
			filter(o => o.filter).
			map(o => o.value)
;

/** rxjs operator that filters out consecutive duplicate values. */
export const filterDuplicatesOperator	= <T> () : (source: Observable<T>) => Observable<T> => {
	let last: T;

	return filter<T>(value => {
		const equal	= last !== undefined && compareValues(last, value);
		last		= value;
		return !equal;
	});
};

/** Filters out undefined values. */
export const filterUndefined			= <T> (arr: (T|undefined|void)[]) : T[] =>
	<T[]> arr.filter(t => t !== undefined)
;

/** rxjs operator that filters out undefined values. */
export const filterUndefinedOperator	= <T> () =>
	<(source: Observable<T|undefined|void>) => Observable<T>>
	filter<T>(t => t !== undefined)
;
