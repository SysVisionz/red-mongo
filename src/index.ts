import {ObjectId} from 'mongodb'
import Redis from 'ioredis'
import mongoose from 'mongoose'

declare global {
	var RedMongo: RedMongo
}

export const pRej = function() {
	let status: string, message: string, res;
	for (const i in Array.from(arguments)){
		switch(typeof arguments[i]){
			case 'number':
				status = arguments[i]
				break;
			case 'string':
				message = arguments[i];
				break;
			default:
				res = arguments[i];
		}
	}
	return (err: any) => {
		return Promise.reject({
		status: (err ? err.status : null) || status || 500, 
		message: (err && err.status 
			? err.message : null) || `${message}${err && err.message ? `
			: ${err.message}` : ''}` || "Unspecified Prej error."
		})
	}
}

interface SchemaTemplate extends mongoose.Schema{
	_id: ObjectId
	[key: string | symbol]: any
}

// const SVZObject = require('svz-object');

interface Schema<T extends SchemaTemplate = SchemaTemplate>{
	redis: Redis;
	mongoose: typeof mongoose;
	__prev: Partial<T>
	__hasBeenModified: (keyof T)[]
	__modified: (keyof T)[]
	__Schema: mongoose.Schema
}

class RedMongo{
	mongoose: typeof mongoose
	redis: Redis
	constructor(Mongoose: typeof mongoose,Redis: Redis){
		this.mongoose = mongoose;
		this.redis = Redis;
	}
	__Schemas: {
		[name: string]: {
			schemaObject: {[key: string]: any}, 
			options: {}
		}
	} = {}
	Schema = class <T extends SchemaTemplate> implements Schema{
		redis =  global.RedMongo.redis
		mongoose = global.RedMongo.mongoose
		__prev: Partial<T>
		__hasBeenModified: (keyof T)[]
		__modified: (keyof T)[];
		static redis = global.RedMongo.redis
		static mongoose = global.RedMongo.mongoose;
		static __Schema: mongoose.Schema

		__preFuncs: {[key: string]: (...args: any[]) => any};
		constructor(data: T, projection: {[key: string | symbol]: any}) {
			this.__prev = {}
			this.__hasBeenModified = [];
			this.__values = data;
			this.__projection = projection;
			this.__modified = [];
			this.__preFuncs = {}
			for (const i in (this.constructor as any).__preFuncs) {
				this.__preFuncs[i] = (this.constructor as any).__preFuncs[i].bind(this)
			}
		}

		// DEFINED BY MODEL
		__Schema?: { [key: keyof T]: mongoose.SchemaDefinitionProperty<any>; } = (this.constructor as any).__Schema
		__priority = [...(this.constructor as any).__priority, '_id']
		__expires = (this.constructor as any).__expires;

		//DEFINED BY STATIC GETTERS
		__dbkeys = (this.constructor as any).__dbkeys
		__keys = (this.constructor as any).__keys
		static __Model: mongoose.Schema = new mongoose.Schema((this.constructor as any).__Schema, {toObject: {virtuals: true}, toJSON: {virtuals: true}});
		// COLIN TODO: implement the application of default values when they are present.
		// static get __hasDefault(){
		// 	const retvals = [];
		// 	for (const i of this.__Schema){
		// 	}
		// }

		__set = (object) => {
			return (this.constructor as any).set(this.redis, this._id.toString(), object)
		}

		static get set(){
			const {redis} = this
			return (_idString: string, object: string) => {
				return redis.zadd(`${(this.constructor as any).name}._id`, 0, _idString).then(() => {
					return redis.hset(`${(this.constructor as any).name}.${_idString}`, object)
				})
			}
		}

		// Expected Input: (redis: the Cache , mObject: a mongoose document)
		// What it does: creates redis object and saves it to our cache layer
		// Returns: redis schema instance built from the Cache
		static get __fromMongooseToRedis(){ return (mObject: typeof this.__Schema) => {
			return new Promise((res, rej) => {
				return this.findById(mObject._id.valueOf(), undefined, {noDB: true}).then(redisHas => {
					if (!redisHas){
						const object = {}
						for (const t in mObject.toObject()) {
							object[t] = this.__objectToRedisTags(mObject.toObject()[t])
							if (typeof object[t] == 'object') {
								object[t] = `JSON:${JSON.stringify(object[t])}`
							}
						}
						//adds to cache
						if (object._id) {
							return this.__set(redis, mObject._id.valueOf(), object).then(() => {
								return this.findById(redis, mObject._id, undefined, {noDB: true}).then( (cached) => {
									return res(cached)
								})
							}).catch(err => rej(err))
						}
						else {
							rej({status: 500, message: 'Something Deep and fundamental Broke in a Colins suggestion kind of way'})
						}
					}
					return res(redisHas)
				})
			})
		}}

		// Expected Input: all database values as a single object
		// What it does: parses the object to dertmine datatype, and recurses if necessary
		// Returns: stringified value with datatype prepended
		static get __objectToRedisTags(){ return value => {
			// get the constructor for the current value
			if ((value === undefined) || (value === null)) {
				return value
			}
			const con = value.constructor
			// depending on the constructor, add an appropriate prefix tag so behaviors can be
			// properly emulated when converting back to a RedisSchema object.
			if (con === ObjectId){
				return `ObjectId:${value.valueOf()}`
			}
			else if (con === Boolean){
				return `Boolean:${value}`
			}
			else if (con === Number){
				return `Number:${value}`
			}
			else if (con === Date){
				return `Date:${value}`
			}
			else if (typeof value === 'object'){
				const retval = con === Object ? {} : []
				for (const i in value){
					retval[i] = this.__objectToRedisTags(value[i])
				}
				return retval
			}
			else {
				return value;
			}
		}}

		// helper definitions
		// make sure to have called _setExpiration() before this, or it won't reset.
		get __redisHash() {
			const hash = []
			hash.push("_id")
			hash.push(this._id.valueOf())
			this.__dbkeys.forEach(i => {
				if (this[i] !== undefined){
					// check whether we're going to pull from the original object or from this by checking the modified status
					const pullFrom = this.isModified(i) ? this : this.__prev;
					// then we use the appropriate object and convert properly into a JSON tagged JSON Object for redis, otherwise just drop it
					// as it is.
					hash.push(i)
					const val = this.tagConvert(pullFrom[i])
					hash.push(typeof val === 'object' ? `JSON:${JSON.stringify(val)}` : val)
				}
			})
			// console.log("hash: " + JSON.stringify(hash))
			hash.push("__redisExpiration");
			hash.push(this.__redisExpiration)
			return hash;
		}

		static get __dbkeys() {
			const keys = [];
			for (const i in this.__Schema) {
				i !== '_id' && keys.push(i)
			}
			return keys;
		}

		get __redisId() {
			// console.log("_id: " +this)
			return `${(this.constructor as any).name}.${this._id.valueOf()}`
		}

		static get __keys() {
			return ['_id', ...this.__dbkeys, ...Array.from(Object.keys(this.__virtuals))]
		}


		get __activeKeys() { return this.__dbkeys.map(key => !!this[key] && key).filter(a => a) }

		get __fullObj() {
			return {...this.__dbObj, __hasBeenModified: this.__hasBeenModified, __redisExpiration: this.__redisExpiration}
		}

		// this is the full mongoose version of any redisSchema based instance.
		get __dbObj() {
			const obj = { _id: this._id }
			for (const i of [...this.__dbkeys]) {
				if (this[i] !== undefined) {
					obj[i] = this[i]
				}
			}
			return obj;
		}

		// Keys are provided by the objects in the static keys object for each schema.
		set __values(data) {
			// if it's an array, not likely to happen
			if (data.indexOf) {
				for (let i = 1; i < data.length; i += 2) {
					const index = data[i - 1]
					const value = data[i]
					// console.log(index)
					// console.log(value)
					// console.log(this._id)
					this[index] = this.__castFromRedis(value)
				}
			}
			else {  //it's an object
				this._id = data._id ? this.__castFromRedis(data._id) : new ObjectId()
				delete data._id
				for (const i of [...this.__dbkeys, '__hasBeenModified', '__redisExpiration']){
					if (data[i] !== undefined){
						this[i] = this.__castFromRedis(data[i])
					}
				}
			}
			for (const i of this.__dbkeys){
				if (!this[i] && this.__Schema[i] && this.__Schema[i].default){
					this[i] = this.__Schema[i].default
				}
			}
			this.__prev = this.__fullObj
		}

		// Expected input: stringified data with datatype tag
		// What it does: this pulls data from the redis store and converts it to an appropriate javascript object for use with redis schemas.
		// Returns: javascript object
		__castFromRedis = val => {
			if (typeof val === "string"){
				if (!val.indexOf("JSON:")) {
					return this.__castFromRedis(JSON.parse(val.substring(5)))
				}
				else if (!val.indexOf("Number:")){
					return Number(val.substring(7))
				}
				else if (!val.indexOf("ObjectId:")){
					return ObjectId(val.substring(9))
				}
				else if (!val.indexOf("Boolean:")){
					return (val.substring(8) == 'true')
				}
				else if (val === "null"){
					return null;
				}
				else {
					return val
				} 
			}
			else if (val && val.constructor === Array) {
				return val.map(i => this.__castFromRedis(i))
			}
			else if (val && val.constructor === Object) {
				const castObj = {}
				for (const i of Object.keys(val)){
					if (val[i]){
						castObj[i] = this.__castFromRedis(val[i])
					}
				}
				return castObj;
			}
			else{
				return val;
			}
		}

		//converts data from Storage to proper types for instances.
		static get __doCast() {
			return (val, Schema) => {
				// This makes the check as to whether we have a tagged JSON art
				
				// if (typeof val === "string" && !val.indexOf("JSON:"))
				if (Schema === ObjectId || Schema === mongoose.Schema.Types.ObjectId && val.constructor !== ObjectId) {
					// @ts-ignore
					return ObjectId(val)
				}
				else if (Schema && Schema.type) {
					return this.__doCast(val, Schema.type)
				}
				else if (Schema === Date || (Schema && Schema.type === Date) && val.constructor !== Date) {
					return val && new Date(val)
				}
				else if (Schema === Array || (Schema && Schema.type === Array && val.constructor !== Array)) {
					return Array.from(val)
				}
				else if ([Boolean, Number].includes(Schema) && Schema !== val.constructor){
					return Schema(val);
				}
				else {
					return val;
				}
			}
		}

		get _doPrefuncs() {
			return ({
				save: skip => new Promise<void>((res) => {
					if (this.__preFuncs.save && !skip) {
						return this.__preFuncs.save(res)
					}
					else {
						return res()
					}
				})
			})
		}

		// this checks if the value has peen modified from the previous version of this
		// value
		isModified = (val) => {
			return (typeof this[val] !== 'object' && this.__prev[val] !== this[val]) || this.__modified.includes(val)
		}

		_getHasBeenModified = () => this.__dbkeys.map(key => {
			return this.isModified(key) || this.__hasBeenModified.includes(key) ? key : null
		}).filter(a => a)

		// save will check that the variables fit the requirements outlined in Schema, save to the redis store, then save to the database.
		// options can include "toDatabase" options, which will save it directly to the database even without priority options
		// and "noDB", which will avoid even bothering with the DB, even with priority options.

		__getFromStore = (options) => {
			return (this.constructor as any).__getFromStore(this.redis, this._id, options)
		}

		static get __getFromStore() {
			return (redis, _id, options) => {
				return redis.hgetall(`${(this.constructor as any).name}.${_id}`).then(obj => {
					return Object.keys(obj).length
						? new this(redis, obj)
						: !options.noDB ? this.__Model.findById(_id, undefined, options)
							: null
				})
			}
		}

		/** Saves your database entry. This will  */
		save = (options: {skipExpiration?: boolean, noDB?: boolean} = {}) => {
			return new Promise((res, rej) => {
				if (!options.skipExpiration) {
					this._setExpiration()
				}
				// because for several functions in mongodb and in redisSchema itself we need to know that any entirely new entry
				// marks ALL its values as "modified," we require that this is done. We know that this is a "new" thing because
				// it has no predecessor (and options.noDB means we're only working on things that are by definition in the cache or
				// shouldn't be in the database at all)
				return this.__getFromStore({ ...options }).then(prev => {
					if (!prev && !options.noDB) {
						this.__activeKeys.forEach(val => this.markModified(val))
					}
					return this._doPrefuncs.save(options.skipPre).then(() => {
						// console.log('did prefunc')
						for (const i of this.__dbkeys) {
							if (!this.__validate(i, this[i])) {
								return rej(`Validation failed for ${i} on ${(this.constructor as any).name} object with _id ${this._id}`)
							}
						}
						return this._addToCache()
							.then(() => {
								if (options.noDB) {
									return res(prev)
								}
								if (this._getHasBeenModified().map(modded => this.__priority.includes(modded)).includes(true) || options.forceDB) {
									const {forceDB, noDB, skipPre, skipExpiration} = options;
									[forceDB, noDB, skipPre, skipExpiration].map (val => delete options[val])
									return this.__Model.findById(this._id).then(document => {
										if (!document){
											document = new this.__Model(this.__dbObj)
										}
										this._getHasBeenModified().forEach(value => {
											document[value] = this[value]
											document.markModified(value)
										})
										return document.save().then(() => {
											this.__modified = [];
											this.__hasBeenModified = [];
											this.__prev = this.__fullObj
											return this.save({noDB: true, skipPre: true, skipExpiration: true}).then(() => {
												res(prev);
											})
										}).catch(err => rej(err))
									}).catch(err => rej(err))
								}
								else {
									res(prev)
								}
							}).catch(err => rej(err))
					}).catch(err => rej(err))
				}).catch((err: any) => rej(err))
			})
		}

		//Lookup, and Delete, goes Directly to DB, as deletion events are Rare
		static get deleteOne() {
			return (redis, params, options) => {
				return new Promise((resolve, reject) => {
					// console.log(`Static Deleting One ${params}`)
					try {
						return this.findOne(redis, params).then(target => {
							if (target) {
								redis.hdel(__redisId).then(() => {
									options.noDB
										? resolve({ acknowledged: true, deleted: 1 })
										: this.__Model.deleteOne(params, options).then(res => {
											resolve(res)
										}).catch(err => reject(err))
								}).catch(err => reject(err))
							}
							else if (!options.noDB) {
								this.__Model.deleteOne(params, options).then(res => {
									resolve(res)
								}).catch(err => rej(err))
							}
						}).catch(err => reject(err))
					}
					catch {
						resolve({ acknowledged: false, deleted: 0 })
					}
				})
			}
		}

		//Method to Delete oneself
		//ref: https://www.codota.com/code/javascript/functions/ioredis/Redis/del
		deleteOne = (redis, options) => {
			// console.log(`Deleting: ${(this.constructor as any).name} id: ${this._id.valueOf()}`)
			return this.redis.hdel().then(() => {
				if (!options.noDB) {
					return this.__Model.findByIDAndDelete(this._id).catch(err => rej(err))
				}
			})
		}

		static get findByIdAndDelete() {
			return (_id: ObjectId, options: ) => {
				this.findById(_id).then(doc => {
					doc.deleteOne(options).catch(err => rej(err))
				})
			}
		}

		//Unused
		// _prioritySaveCheck = () => {
		// 	// console.log(`Checking Priororty Saves ${this.__Model}`)
		// 	return new Promise((res, rej) => {
		// 		return this.findById(this._id).then( doc => {
		// 			if (!(list && list.length)){
		// 				return doc.save().then(() => {
		// 					this._makeRedisObj().then(redisObj => res({ prev: doc, redisObj })).catch(err => rej(err))
		// 				}).catch(err => rej(err))
		// 			}
		// 			if (this.modified.length) {
		// 				for (const i of this.modified) {
		// 					if (this.__priority.includes(i)) {
		// 						prev = new this.constructor(this.redis, doc.toObject())
		// 						for (const i of this.modified) {
		// 							doc.markModified(i)
		// 						}
		// 						return doc.save().then(() => {
		// 							this._makeRedisObj().then(redisObj => res({ prev, redisObj })).catch(err => rej(err))
		// 						}).catch(err => rej(err))
		// 					}
		// 				}
		// 			}
		// 			this._makeRedisObj().then(redisObj => res({ prev: this, redisObj })).catch(err => rej(err))
		// 		}).catch(err => rej(err))
		// 	})
		// }

		static get pre() {
			return (type, callback) => {
				// if (this.__preFuncs[type]){
				if (!this.__preFuncs) {
					this.__preFuncs = { [type]: callback };
				}
				else {
					this.__preFuncs[type] = callback
				}
				// }
				// else {
				// 	this.__preFuncs[type].push(callback);
				// }
			}
		}

		// markModified will highlight the values that have been changed in the redis store, acting as notifications for refresh process to save
		// to the database on the next applicable rotation. In addition, this will save values with "unique" or "priority" in the schema to the
		// database immediately.
		markModified = (val) => {
			// TODO: Colin, still needs to set "unique" or "priority" flags
			// console.log(`Marking Modified`)
			!this.__modified.includes(val) && this.__modified.push(val);
		}

		// _getCache takes redis as an argument. It then returns the full list of entries for this TYPE of entry in the redis cache.
		// importantly, this is a list of redisSchema objects.
		static get _getCache() {
			return (redis, projection) => {
				return new Promise((resolve, reject) => {
					// redis lrange 
					const set = `${(this.constructor as any).name}._id`
					return redis.zrange(set, 0, -1).then(_ids => {
						const nextVal = () => {
							return new Promise((res, rej) => {
								// if there are no ids, resolve an empty array.
								if (!_ids.length) {
									return res([])
								}
								// otherwise, pop out the last entry.
								const curr = _ids.pop()
								// redis pulls the hash for the current 
								return redis.hgetall(`${(this.constructor as any).name}.${curr}`).then(values => {
									return _ids.length
										? nextVal().then(list => {
											res([...list, new this(redis, values)])
										}).catch(err => rej(err))
										: res([new this(redis, values)])
								}).catch(err => rej(err))
							})
						}
						return nextVal().then(list => {
							return resolve(list)
						}).catch(err => reject(err))
					}).catch(err => reject(err))
				})
			}
		}

		_getCache() {
			return (this.constructor as any)._getCache(this.redis, this.projection)
		}

		_addToCache = () => {
			// console.log("email" + this.email)
			// console.log("_id" + this._id)
			return new Promise((res, rej) => {
				if (this._id) {
					return this.redis.zadd(`${(this.constructor as any).name}._id`, 0, this._id.valueOf()).then(() => {
						// console.log("this:")
						// console.log(this)
						const object = {}
						object.__hasBeenModified = `JSON:${JSON.stringify(this._getHasBeenModified())}`
						for (const t in this.toObject()) {
							object[t] = (this.constructor as any).__objectToRedisTags(this.toObject()[t])
							if (typeof object[t] == 'object') {
								object[t] = `JSON:${JSON.stringify(object[t])}`
							}
						}
						return this.__set(object).then(() => res()).catch(err => rej(err))
					}).catch(err => rej(err))
				}
				res()
			})
		}

		// set the expiration time for autodump and removal from redis cache.
		_setExpiration = () => {
			return this.__set(['__redisExpiration', new Date().valueOf() + this.__expiration])
		}

		static get _setExpirationList(){
			return list => {
				if(!list.length){
					return new Promise(res => res())
				}
				const curr = list.pop()
				return curr._setExpiration().then(() => {
					return list.length ? this._setExpirationList(list) : true
				})
			}
		}

		__valueIsObjectId = (this.constructor as any).__valueIsObjectId

		static get __valueIsObjectId() {
			return (index, Schema = this.__Schema) => {
				if (index === '_id') {
					return true;
				}
				else if (index === '__redisExpiration') {
					return false;
				}
				else if (Schema[index] && Schema[index].type && [ObjectId, mongoose.Schema.Types.ObjectId].includes(Schema[index].type)) {
					return true;
				}
				else if (Schema[index] && [ObjectId, mongoose.Schema.Types.ObjectId].includes(Schema[index])) {
					return true;
				}
				return false;
			}
		}

		__doCast = (this.constructor as any).__doCast

		// __validate is a helper function for running validation for variable modification.
		// validate is currently rejecting ObjectIds for some things?
		__validate = (key, value) => {
			// validates based on type provided. Note that Decimal128 and Map aren't applicable.
			// true is successful validation.
			if ((this.__Schema[key].required || this.__Schema[key].unique) && !value) {
				return false;
			}
			if (!value) {
				return true;
			}
			if (this.__valueIsObjectId(key)) {
				if (value && value.constructor !== ObjectId) {
					return false;
				}
			}
			else if (this.__Schema[key] !== mongoose.Schema.Types.Mixed && this.__Schema[key].type !== mongoose.Schema.Types.Mixed) {
				if (this.__Schema[key].type && value.constructor && [String, Number, Date, Buffer, Boolean].includes(this.__Schema[key].type) && value.constructor !== this.__Schema[key].type) {
					return false
				}
				if (this.__Schema[key] && value.constructor && [String, Number, Boolean].includes(this.__Schema[key]) && value.constructor !== this.__Schema[key]) {
					return false;
				}
			}
			else if (this.__Schema[key] && value && this.__Schema[key] === Date) {
				if (['string', 'number'].includes(typeof value)) {
					try {
						new Date(value)
					}
					catch {
						return false;
					}
				}
				else {
					return value.constructor === Date
				}
			}
			else if (this.__Schema[key].validate && !this.__Schema[key].validate.validator(value)) {
				return false;
			}
			return true;
		}

		//MAAYYYYBE unused
		// _makeRedisObj = () => {
		// 	// console.log(`MakingRedisObject`)
		// 	return new Promise((res, rej) => {
		// 		// this section uses a findById that searches only the cache, and then combines this with the existing object
		// 		// overwriting the values with the ones given here.
		// 		// Note that _id is already matching by definition, so dbkeys appropriately doesn't check that one.
		// 		(this.constructor as any).findById(this.redis, this._id, undefined, { noDB: true }).then(fromRedis => {
		// 			const retval = {}
		// 			for (const i in this.__dbkeys) {
		// 			}
		// 			this.modified = [];
		// 			res(fromRedis)
		// 		}).catch(err => rej(err))
		// 	})
		// }

		// for now, we haven't got any places where we use toObject with its actual options.
		// As a result, options are included as a variable but not used.
		// TODO: resolve this in future updates to access full toObject versatility.
		toObject = options => {
			const obj = {};
			for (const i of this.__keys) {
				if (this[i]!== undefined){
					if (!this.__projection) {
						obj[i] = this[i]
					}
					else if (this.__projection.includes(i)) {
						obj[i] = this[i];
					}
				}
			}
			return obj;
		}

		set __projection(projection) {
			if (!projection) {
				this.__projectionVal = this.keys;
			}
			else if (typeof projection === 'object') {
				this.__projectionVal = projection.indexOf ? ['_id', ...projection] : [(projection._id !== undefined && !projection._id ? null : "_id"), ...Object.keys(projection).map(key => projection[key]).filter(a => a !== undefined)]
			}
			else if (typeof projection === 'string') {
				this.__projectionVal = projection.split(' ')
			}
			else {
				throw "Not a valid projection."
			}
		}


		get projection() {
			return this.__projectionVal
		}


		_matchesQuery = (query) => {
			return (this.constructor as any)._matchesQuery(query, this)
		}


		static get __processQuery() {
			return (command, queryVal, obj, fullQuery) => {
				if (!obj) {
					return false;
				}
				switch (command) {
					case 'lt':
						return queryVal["$lt"] > obj
					case 'lte':
						return queryVal["$lte"] >= obj
					case 'gt':
						return queryVal["$gt"] < obj
					case 'gte':
						return queryVal["$gte"] <= obj
					case 'regex':
						// console.log(obj)
						// console.log(!!obj.match(RegExp(queryVal["$regex"], queryVal['$options'])))
						try {
							// console.log(!!obj.match(RegExp(queryVal["$regex"], queryVal['$options'])))
							return !!obj.match(RegExp(queryVal["$regex"], fullQuery['$options']))
						}
						catch {
							return false;
						}
					case 'eq':
						// figure out how this interacts with regex more precisely, leaving just as == for now.
						// TODO: Colin, comment says == but return says ===. Verify it's the right comparison
						return obj.constructor === ObjectId ? obj.equals(queryVal['$eq']) : queryVal["$eq"] === obj;
					case 'ne':
						return queryVal["$ne"] !== obj;
					case 'in':
						if (typeof queryVal["$in"] === 'object') {
							for (const val of queryVal["$in"]) {
								if (obj.includes(val)) {
									return true;
								}
							}
							return false;
						}
						return obj.includes(queryVal["$in"]);
					case 'nin':
						if (typeof queryVal["$nin"] === 'object') {
							for (const val of queryVal["$nin"]) {
								if (obj.includes(val)) {
									return false;
								}
							}
						}
						return !obj.includes(queryVal["$nin"]);
					case 'and':
						return !queryVal["$and"].map(val => this._matchesQuery(val, obj)).includes(false)
					case 'not':
						return !this._matchesQuery(queryVal["$not"], obj, queryVal)
					case 'nor':
						return !queryVal["$nor"].map(val => this._matchesQuery(val, obj)).includes(true)
					case 'or':
						return queryVal["$or"].map(val => this._matchesQuery(val, obj)).includes(true)
					case 'exists':
						return !!obj;
					case 'type':
						switch (queryVal["$type"]) {
							// case "double": TODO: this one's odd. I think doubles have to be strings in javascript? I'll go into it more later.
							case "string":
								return typeof obj === queryVal.$type
							case "object":
								try{
									return obj && obj.constructor === Object
								}
								catch{
									return false;
								}
							case "undefined":
								return typeof obj === queryVal.$type
							case "array":
								try {
									return obj && obj.constructor === Array;
								}
								catch {
									return false;
								}
							case "binData":
								// verify that this is binary data. Not sure if this is supposed to be a string or a number or an array,
								// so I basically did... all?
								try {
									return obj.constructor === Array
										? obj.map(val => [0, 1].includes(val))
										: typeof obj === 'string'
											? !obj.split("").map(val => [0, 1].includes(val)).includes(false)
											: typeof obj === 'number'
												? !String(query(i)).split("").map(val => [0, 1].includes(val)).includes(false)
												: false
								}
								catch {
									return false;
								}
							case "objectId":
								try {
									return obj.constructor === ObjectId || !!ObjectId(obj)
								}
								catch {
									return false;
								}
							case "bool":
								return typeof obj === "boolean"
							case "date":
								try {
									return !!new Date(obj)
								}
								catch {
									return false;
								}
							case "null":
								return obj === null
							// case "javascript": TODO: I THINK this is when you put a string that executes as javascript. I don't think you can put functions
							// directly into mongoose. Someday I'll look into it. Someday that is not now.
							case "int":
								return Number.isInteger(obj);
							// I'm not sure if this will ONLY work for 32 bit integers or if it will accept 64 bit integers.
							// for now I don't care.
							// case "Timestamp": TODO: this is one I'll have to do more work to parse out.
							case "long":
								return Number.isInteger(obj)
							// see note on int.
							case "decimal":
								// not sure what else this would be than "a number that has decimal places," but I'll verify this more later.
								return typeof obj === 'number' && String(obj).includes('.');
							// case "minKey": TODO: not entirely sure what... these are, frankly.
							// case "maxKey":
							default:
								throw "Invalid BSON type string provided. Consult https://docs.mongodb.com/manual/reference/bson-types/"
						}
					case 'expr':
						return queryVal["$expr"](obj);
					case 'jsonSchema':
					// this requires extra analysis. I'm not entirely clear on how it works.
					case 'mod':
						return obj % queryVal["$mod"][0] == queryVal["$mod"][1]
					case 'text':
						// Later we can add the "$language" tag.
						const process = (string) => {
							if (!queryVal["$text"]["$diacriticSensitive"] === undefined ? false : queryVal["$text"]["$diacriticSensitive"]) {
								return process(string.normalize("NFD").replace(/[\u0300-\u036f]/g, ""))
							}
							return queryVal["$text"]["$caseSensitive"] === undefined ? false : queryVal["$text"]["$caseSensitive"] ? string : string.toLowerCase();
						}
						return process(obj).includes(queryVal["$text"]["$string"]);
					// A lot of stuff with https://docs.mongodb.com/manual/reference/operator/query/text/__match-operation can be included later, but for now our only use doesn't really require it.
					case 'where':
						// We can add the processing of the value in the case of a javascript function string later. I don't really like doing string executions within
						// queries, particularly within databases, as this can be a security concern, but if we're making this public it should be an options
						return queryVal["$where"](obj);
					case 'geoIntersects':
					// do later.
					case 'geoWithin':
					// do later.
					case 'near':
					// do later.
					case 'nearSphere':
					// do later.
					case 'box':
					// do later.
					case 'center':
					// do later.
					case 'centerSphere':
					// do later.
					case 'geometry':
					// do later.
					case 'maxDistance':
					// do later.
					case 'minDistance':
					// do later.
					case 'polygon':
					// do later.
					case 'uniqueDocs':
					// do later.
					case 'all':
						if (!queryVal["$all"].constructor === Array) {
							throw "$all must be an array"
						}
						return !queryVal["$all"].map(val => obj && obj.includes(val)).includes(false)
					case 'elemMatch':
						// can also accept projections, but no need to worry about it now.
						if (queryVal["$elemMatch"].constructor === Object && Object.keys(queryVal["$elemMatch"]).map(key => key.includes("$")).includes(true)) {
							return !queryVal["$elemMatch"].map(qry => this._matchesQuery(qry, obj)).includes(false)
						}
					case 'size':
						// TODO: Colin, is this complete?
						if (object.length !== queryVal["$size"]) {
							return false;
						}
					case 'bitsAllClear':
					// do later
					case 'bitsAllSet':
					// do later
					case 'bitsAnyClear':
					// do later
					case 'bitsAnySet':
					// do later
					case 'slice':
					// projection operator. Do later.
					case 'comment':
					// do later.
					case 'rand':
					// do later.
					default:
					// this primarily operates for the $ operator and for rejections
					//projection operator.
				}
				return true;
			}
		}


		static get _matchesQuery() {
			// this gets the redisSchema document and the mongoose style query object passed in originally
			// returns true if it matches the query, false if it does not.
			return (query, object, fullQuery) => {
				// Checks if query is empty or is completed
				if (!query || !Object.keys(query).length) {
					return true
				}
				// if this is a direct equals for a number, string, ObjectId,
				if (Object.keys(query).length === 1 || typeof query === "string" || query.equals) {
					let key = Object.keys(query)[0]
					// in the case of {event: {"dates.start": thing}} in the query, we need to end up from {event: {dates: {start: thing}}} to {start: thing}
					if (key.includes('.')) {
						const list = key.split('.')
						list.forEach(element => {
							if (object[element]) {
								object = object[element]
							}
							else {
								return false;
							}
						});
						query = query[key]
						key = list[list.length - 1]
					}
					if (query.equals){
						return object.constructor === Array 
						? object.map(val => query.equals(val)).includes(true)
						: query.equals(object)
					}
					if (key.charAt(0) === "$") {
						const que = Object.keys(query)[0]
						return this.__processQuery(que.substring(1), query, object, fullQuery)
					}
					if (query[key] && query[key].constructor === ObjectId){
						if (!object[key]){
							return false;
						}
						return object[key].constructor === Array ? !!~this.indexOfIn(query[key], object[key]) : query[key].equals(object[key])
					}
					if (query[key] && ['string', 'number', 'boolean', 'bigint'].includes(typeof query[key]) ) {
						if (!object[key]){
							return false;
						}
						return object[key].constructor === Array ? object[key].includes(query[key]) : query[key] == object[key]
					}
					if (typeof query === 'object') {
						// Sometimes undefined will be true, in the case of $not, so we do a quick check for it here.
						if (query && query[key] && Object.keys(query[key]) && Object.keys(query[key])[0] === "$not"){
							return !this._matchesQuery(query[key].$not, object[key], query[key])
						}
						return object[key] === undefined ? false : this._matchesQuery(query[key], object[key], fullQuery)
					}
				}
				// if there's more than one, loop through recursively until a false.
				for (const i in query) {
					// in the case of an atomic operator ("$regex" for instance), we shouldn't keep going down in the object.
					// otherwise, take another step down.
					if (this._matchesQuery({ [i]: query[i] }, object, query) === false) {
						return false;
					}
				}
				return true;
				// console.log("query")
				// console.log(query)
				// console.log("object")
				// console.log(object)
				// for (const i in query){
				// 	query[i] = this.__doCast(query[i], i, 'query')
				// }
			}
		}


		static get findById() {
			return (_id: ObjectId, projection?: {}, options = {}, callback) => {
				// console.log(`Finding by ID: ${_id}`)
				const {redis} = this
				if (!_id) {
					return new Promise((res, rej) => rej("No _id provided to findById"))
				}
				if (_id.constructor !== ObjectId) {
					_id = ObjectIdObjectIdObjectId(_id)
				}
				return redis.hgetall(`${(this.constructor as any).name}.${_id.toString()}`).then(redisObj => {
					// console.log("keys: ")
					// console.log(Object.keys(redisObj).length)
					// console.log('options: ')
					// console.log(options)
					if (Object.keys(redisObj).length){
						const inst = new this(redis, redisObj);
						return !options.noExpire 
						? inst._setExpiration().then(() => inst)
						: inst;
					}
					else{
						return options.noDB ? null : this.__Model.findById(_id, undefined, options, callback).then(doc => {
							// console.log("email: " +doc.email)
							if (doc) {
								return this.__fromMongooseToRedis(redis, doc).catch(err => Promise.reject(err))
							}
							return null;
						}).catch(err => Promise.reject(err))
					}
				})
			}
		}

		//Custom Options: maxVals, and noDB
		static get find() {
			return (redis, params, projection, options = {}, callback) => {
				const {maxVals, noDB, noExpire} = options
				delete options.maxVals
				delete options.noDB;
				delete options.noExpire
				if (!Object.keys(options)){
					options = undefined
				}
				// console.log(`Finding in Cache: ${params}`)
				return new Promise((res, rej) => {
					return this._check(redis, projection, item => item._matchesQuery(params)).then(list => {
						if (noDB || (maxVals && list.length >= maxVals)) {
							// console.log('not searching db')
							return res(maxVals ? list.slice(0, maxVals) : list)
						}
						// console.log("type: " + (this.constructor as any).name)
						// console.log("found:")
						// console.log(list.map(item => item._id))
						if (!maxVals || list.length < maxVals) {
							// console.log('params: ')
							// console.log(params)
							//BUG: __157 querey fails here on home page refresh
							return this.__Model.find(params, undefined, options, callback).limit(maxVals).then(docs => {
								// console.log('names: ')
								// console.log(docs.map(doc => doc.name))
								return this.__saveDocs(redis, docs, projection).then(docs => {
									if (!noExpire){
										return this._setExpirationList({...docs}).then(() => {
											return res(docs)
										}).catch(pRej('failed to set expiration for found docs'))
									}
									else {
										return res(docs)
									}
								}).catch(err => rej(err))
							}).catch(err => rej(err))
						}
						else {
							return (options.maxVals && list.length < options.maxVals
								? this.__Model.find(params, undefined, options, callback).limit(options.maxVals).then(docs => {
									if (list.length === docs.length) {
										for (const i of list) {
											if (!docs.map(doc => listItem._id.equals(doc._id)).includes(true)) {
												return this.__createAndCache(redis, docs, list, autoPush).then(() => res(list.slice(0, options.maxVals))).catch(err => rej(err))
											}
										}
										return res(list)
									}
								}).catch(err => rej(err))
								: res(list.slice(0, options.maxVals))
							)
						}
					}).catch(err => rej(err))
				})
			}
		}

		// Expected input: redis: Active Cache, docs: array of Mongoose Docs, projection: passed down just the same
		// What it does: Saves Monggose Docs into Cache
		// Returns: array of new instances
		static get __saveDocs () { return (redis, docs, projection) => {
			return new Promise((resSave, rejSave) => {
				if (!docs || !docs.length) {
					return resSave([])
				}
				//const doc = new this(redis, docs.pop(), projection)
				// console.log('doc?')
				// console.log(doc)
				return this.__fromMongooseToRedis(redis, docs.pop()).then((cachedDoc) => {
					// console.log(doc._id + " saved to cache")
					return this.__saveDocs (redis, docs).then(cachedDocs => resSave([...cachedDocs, cachedDoc])).catch(err => rejSave(err)) 
				}).catch(err => rejSave(err))
			})
		}}

		// Expected input: redis object, docs is an array of mongoose objects, list is an array of redis schema objects,
		// autoPush is a boolean
		// What it does: pushes a list of mogoose documents, and putting them into cache
		// Returns: Resolve or Rejection to give Status
		static get __createAndCache(){ return (redis, docs, list, autoPush) => {
			return new Promise((resCreate, rejCreate) => {
				if (!list.length || autoPush) {
					doc = new this(redis, docs.pop());
					list.push(doc)
					return doc.save({ noDB: true }).then(() => {
						return docs.length ? this.__createAndCache(docs, true).then(() => {
							return resCreate()
						}).catch(err => rejCreate(err)) : resCreate()
					}).catch(err => rejCreate(err))
				}
				if (docs.length) {
					doc = docs.pop()
					// check if this document is already contained within the list of cached documents, and don't add it if so.
					list.forEach(listItem => {
						if (listItem._id.equals(doc._id)) {
							return this.__createAndCache(docs).catch(err => rejCreate(err));
						}
					})
					// if not, then create it and save it to cache.
					doc = new this(redis, doc);
					list.push(doc)
					return doc.save({ noDB: true }).then(() => {
						return docs.length ? this.__createAndCache(docs).then(() => {
							resCreate().catch(err => rejCreate(err))
						}).catch(err => rejCreate(err)) 
						: resCreate()
					}).catch(err => rejCreate(err))
				}
			})
		}}

		// note that statics must always include the redis object as their first argument.
		// this is because they can't actually have the redis object declared in their constructor,
		// as they have no constructor.
		static get findOne() {
			return (params: typeof this.__Schema, projection: , options = {}, callback) => {
				// console.log("params for findOne:")
				// console.log(params)
				return this.find(params, projection, { ...options, maxVals: 1 }, callback).then(list => {
					// console.log("found")
					// console.log(list)
					return list[0]
				})
			}
		}

		// _check grabs all of the current redis values from the database that apply to this.
		// it then parses them into an array of the appropriate redisSchema types. So for redisUser,
		// it would return [redisUser, redisUser, redisUser] as an array of instances.
		static get _check() {
			return (redis, projection, callback, max = -1, sectionBy = 10, soFar = 0) => {
				// console.log('Getting redis values')
				return new Promise((res, rej) => {
					return this._getCache(redis, projection).then(list => {
						// console.log("list: ")
						// console.log(list)
						if (!callback) {
							return res(list)
						}
						return res(list.filter(item => callback(item)))
					}).catch(err => rej(err))
				})
			}
		}

		// dbids:
		// user: 0
		// event: 1
		// chat: 2
		// questions: 3
		// breakouts: 4
		// friendList: 5
		// sponsor: 6
		// ticket: 7

		static get findOneAndUpdate() {
			return (redis, params, update, options = {}) => {
				// FUTURE: options should be implemented later, for now I'm just making it work and not worrying about them.
				// console.log(`Finding One and Updating: ${params}`)
				return this.findOne(redis, params, options).then(document => {
					if (!document) {
						return null;
					}
					const prev = document
					return document.updateOne(update, options).then(() => prev).catch(err => rej(err))
				})
			}
		}

		static get updateOne() { return this.findOneAndUpdate }

		get update() { return this.updateOne }

		// updateOne is a function that performs the updating of values within the instance, and then saves it.
		// it takes updateObj, which is the query update object, options are the options for the save function in question,
		// the later ones used in updateStuff are programatically generated.
		// this finalizes by returning the completed "prev" object from a normal save function, which is performed post-modification.
		updateOne = (update, options = {}) => {
			// console.log(`Updating: ${update}, with options: ${options}`)
			if (!update) {
				return new Promise((res, rej) => rej('update requires a update object'))
			}
			try {
				for (const i in update) {
					if (i.charAt(0) === ("$")) {
						this.__updateStuff(update[i], i.substring(1))
					}
					else {
						this.__updateStuff(update, "set")
					}
				}
			}
			catch {
				return new Promise((res, rej) => rej('failed to update because of malformed update values'))
			}
			return this.save(options)
		}

		__updateStuff = (updateObj, operator) => new Promise((res, rej) => {
			for (const i in updateObj) {
				this[i] = this.__processUpdate(updateObj[i], operator, this[i])
			}
			// if (key.includes('.')){
			// 	const list = key.split('.')
			// 	list.forEach(element => {
			// 		if (object[element]){
			// 			object = object[element]
			// 		}

			// 		else{
			// 			return false;
			// 		}
			// 	});
			// 	query = {[list[list.length - 1]]: query[key]}
			// 	key = list[list.length - 1]
			// }
			// TODO: later implement dot notation
			// if (Object.keys().includes(".")){

			// }
			// updateObj[i] = this.__doCast(updateObj[i], i, 'update')
			// if (i.charAt(0) === '$') {
			// 	updateStuff(updateObj[i], options, current, i.substring(1), diveArray).then(results => res({...current, ...results})).catch(err => rej(err))
			// }
			// else if (i.includes('.') && operator) {
			// 	// this initiates the "dive" for when the value is provided through the string
			// with periods value.
			// const toDive = i.split('.');
			// newVal = toDive.slice(1).join(".")
			// updateObj[toDive[0]] = updateObj[i]
			// delete updateObj[i]
			// }
		})

		__processUpdate = (updateObj, operator, target) => {
			// recurse if we don't have an operator already, applying set.
			switch (operator) {
				// find operators at https://docs.mongodb.com/manual/reference/operator/update/
				// case 'currentDate': TODO: make it work
				case 'inc':
					return target + updateObj;
				case 'min':
					if (updateObj < target) {
						return updateObj
					}
					return target
				case 'max':
					if (updateObj > target) {
						return updateObj;
					}
					return target;
				case 'mul':
					return target * updateObj;
				// case 'rename': TODO: later
				case 'set':
					// note: this has to be the top level value. Others may require this, so just use the same thing.
					return updateObj
				// case 'setOnInsert': TODO: later
				case 'unset':
					return null;
				case 'addToSet':
					// like push, except returned array has unique values
					// error out if not array
					if (!Array.isArray(target)) {
						throw 'Field is not an array'
					}
					// change updateObj.constructor === Object
					else if (updateObj.constructor !== Object) {
						if (target.indexOf(updateObj) === -1) {
							// if updateObj does not contain $each,
							// push it to the current array
							target.push(updateObj);
						}
						return target;
					} else {
						if (!!updateObj['$each']) {
							arr = updateObj['$each'];
							arr.forEach(thing => {
								if (target.indexOf(thing) === -1) {
									target.push(thing);
								}
							})
							return target;
						} else {
							target.push(updateObj);
							return target;
						}
					}
				case 'pop':
					// TODO: check this, not used yet
					if (!Array.isArray(target)) {
						throw 'Field is not an array';
					}
					else if (updateObj === -1) {
						// remove first
						return target.slice(1, target.length);
					} else {
						// remove last
						return target.slice(0, target.length - 1);
					}
				case 'pull':
					// TODO: check this, not used yet
					if (Array.isArray(target)) {
						throw 'Field is not an array';
					} else {
						updateObj.forEach(thing => {
							const index = target.indexOf(thing);
							if (index > -1) {
								target.splice(index, 1);
							}
						})
						return target;
					}
					break;
				// TODO: make conditional matches work
				case 'push':
					if (target === undefined) {
						return updateObj['$each'] ? updateObj['$each'] : updateObj;
					}
					if (!Array.isArray(target)) {
						throw 'Field is not an array';
					}
					else if (!(updateObj.constructor === Object)) {
						// if updateObj does not contain $each,
						// push it to the current array
						target.push(updateObj);
						return target;
					} else {
						if (!!updateObj['$each']) {
							// must contain keyword $each, otherwise just push updateObj
							const arr = updateObj['$each'];
							if (updateObj['$position'] !== undefined) {
								const pos = updateObj['$position'];
								arr.forEach(thing => {
									target.splice(pos, 0, thing);
								})
							} else {
								arr.forEach(thing => {
									target.push(thing);
								})
							}
							if (updateObj['$slice'] !== undefined) {
								sliceNum = updateObj['$slice'];
								if (sliceNum === 0) {
									updateObj = [];
								} else if (sliceNum > 0) {
									target = target.slice(0, sliceNum);
								} else {
									target = target.slice(target.length - sliceNum, target.length);
								}
							}
							return target;
						} else if (!!updateObj['$position'] || !!updateObj['$slice']) {
							throw 'requires the modifier $each to be present';
						} else {
							target.push(updateObj);
							return target;
						}
						// TODO: build out for sort
					}
				// case 'pullAll': TODO: later
				// case 'sort': TODO: later
				// case 'bit': TODO: later
				default:
					throw 'Operator not defined';
				// this encompasses the $, $[] and $[<identifier>] operators at https://docs.mongodb.com/manual/reference/operator/update-array/
				// should also process rejections, of course.
			}
		}

		//a Slow Alternative Method that always checks BOTH
		// this is now accomplished with adding the "directToDatabase: true" option.
		// static get findFull() {
		// 	return (redis, params, callback) => {
		// 		console.log(`FindingFull from everywhre: ${params}`)
		// 		return new Promise((res, rej) => {
		// 			this.getScan(redis).then(cache => {
		// 				if (cache.length) {
		// 					const memList = cache.map(doc => this(redis, doc))
		// 				}
		// 				this.__Model.find(redis, params).then(dbvals => {
		// 					if (dbvals && dbvals.length) {
		// 						const toCache = [...dbvals]
		// 						setToCache = () => {
		// 							return new Promise(res => {
		// 								const curr = toCache.pop();
		// 								const cacheObj = {}
		// 								cacheObj[this.__keys[i]] = curr[this.__keys[i]];
		// 								redis.hset(cacheObj._id)
		// 							})
		// 						}

		// 					}
		// 					if (cache.length && toCache.length) {
		// 						//Combines the Search terms perferring the versions From cache
		// 						const cleanDB = toCache.filter(dbDoc => memlist.some(cacheDoc => (cacheDoc._id == dbDoc._id)))
		// 						return memList.concat(cleanDB)
		// 					}
		// 					if (cache.length) { return cache }
		// 					if (toCache.length) { return toCache }
		// 					else {
		// 						return res(null)
		// 					}
		// 				})
		// 			})
		// 		})
		// 	}
		// }

		__clearFromCache = () => {
			return this.redis.zrem(`${(this.constructor as any).name}._id`, 0, this._id.valueOf() ).then(() => {
				return this.redis.del(`${(this.constructor as any).name}.${this._id.valueOf()}`).catch(pRej('failed to delete entry from cache'))
			})
		}

		// will return the index where the ObjectId or _id of the instance matches the ObjectId or _id of the instance in the array
		// this takes for the first argument EITHER a RedisSchema type instance or an ObjectId.
		static get indexOfIn () { 
			return (instanceOrId, arr, strict) => {
				// if instanceOrId is an ObjectId or strict is true, use it, 
				// otherwise assume this is a redisSchema type object and use its _id
				const id = instanceOrId.constructor === ObjectId || strict ? instanceOrId : instanceOrId._id
				for (const i in arr){
					if (!arr[i]){
						continue;
					}
					// if strict, compare only the explicit data types.
					if (strict){
						if ((instanceOrId.constructor === ObjectId && instanceOrId.equals(arr[i])) || instanceOrId._id.equals(arr[i]._id) ){
							return i;
						}
						else{
							continue
						}
					}
					const curr = arr[i].constructor === ObjectId ? arr[i] : arr[i]._id;
					if (curr.equals(id)){
						return i;
					}
				}
				return -1;
			}
		}

		indexOfIn = array => (this.constructor as any).indexOfIn(this._id, array)

		get __expiration () {
			// use a default time of 1 day. Return this for invalid formats, as well.
			const {__expires = "6h"} = this;

			// if this is already provided in milliseconds, just use that.
			if (typeof __expires === 'number'){
				return __expires
			}
			// this subfunction allows us to pull apart and use the values provided with each index, with the total amount as a prefix (10h is 10 hours, 10h20m is 10 hours 20 minutes)
			const match = val => {
				const matchStrings = __expires.match(RegExp(`[dhms].+${val}`)) || __expires.match(RegExp(`^[0-9\.]+${val}`))
				return matchStrings ? Number(matchStrings[0].match("[0-9\.]+")) : 0;
			}
			let total = 0;
			// the relative milliseconds for each interval of time.
			const time = {
				d: 86400000,
				h: 3600000,
				m: 60000,
				s: 1000
			}
			// here, for each type, pull out the amount provided in the string and multiply it by the total milliseconds.
			for (const i in time){
				total+= match(i)*time[i]
			}
			return total
		}

		static get __performDump() {
			return list => {
			if (!list.length){
				return new Promise(res => res())
			}
			const curr = list.pop();
			if (curr.__hasBeenModified.length){
				return curr.save({forceDB: true, noExpire: true, skipPre: true})
			}
			if (curr.__redisExpiration < new Date().valueOf()){
				return curr.save({forceDB: true, noExpire: true, skipPre: true}).then(() => {
					return curr.__clearFromCache(curr._id).then( () => {
						return list.length ? this.__performDump(list) : true
					}).catch(err => Promise.reject(err))
				}).catch(err => Promise.reject(err))
			}
			return list.length ? this.__performDump(list) : new Promise(res => res())
		}}

		static get __dump() {
			return redis => {
				// console.log(`Cache: Taking a Dump: ${lastDumped}`)
				return this.find(redis, undefined, undefined, {noDB: true}).then(list => {
					return this.__performDump(list).catch(() => {
						console.log('Dump failed for ' + (this.constructor as any).name + '!')
					})
				})
			}
		}
	}
}
export default new Proxy<(Mongoose?: typeof mongoose, Redis?: Redis) => void>((Mongoose?: typeof mongoose, Redis?: Redis) => {}, {
	apply: (Mongoose?: typeof mongoose, Redis?: Redis) => {
		if (global.RedMongo){
			return global.RedMongo
		}
		global.RedMongo = new RedMongo(Mongoose, Redis)
		return global.RedMongo;
	},
	get: (t, p: keyof typeof global.RedMongo): RedMongo[typeof p] => {
		if (!global.RedMongo){
			throw "RedMongo is not initialized. Run RedMongo(Mongoose, Redis) to initialize it."
		}
		return global.RedMongo[p]
	},
	set: (t, p: keyof typeof global.RedMongo, v: any) => {
		if (!global.RedMongo){
			throw "RedMongo is not initialized. Run RedMongo(Mongoose, Redis) to initialize it."
		}
		return global.RedMongo[p] = v;
	}
});