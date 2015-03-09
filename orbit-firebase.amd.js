define('orbit-firebase/array-utils', ['exports'], function (exports) {

	'use strict';

	exports.removeItem = removeItem;
	exports.removeAt = removeAt;

	function removeItem(array, condemned){
		return array.filter(function(item){
			return item !== condemned;
		});
	}

	function removeAt(array, index){
		var working = array.splice(0);
		working.splice(index, 1);
		return working;
	}

});
define('orbit-firebase/cache-utils', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache){
			this.cache = cache;
		},

		retrieveLink: function(type, id, link) {
			var val = this.cache.retrieve([type, id, '__rel', link]);
			if (val !== null && typeof val === 'object') {
				val = Object.keys(val);
			}
			return val;
		},
	});

});
define('orbit-firebase/firebase-cache', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/cache-utils', 'orbit/evented'], function (exports, objects, SchemaUtils, CacheUtils, Evented) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache, serializer, schema){
			Evented['default'].extend(this);
			this._cache = cache;
			this._cacheUtils = new CacheUtils['default'](cache);
			this._serializer = serializer;
			this._schema = schema;
			this._schemaUtils = new SchemaUtils['default'](schema);
			this.step = 0;
		},

		addRecord: function(type, record){
			if(!record) return;
			var serialized = this._serializer.serializeRecord(type, record);
			this.transformCache({ op: 'add', path: [type, this.getId(type, record)], value: record });
			this.emit("recordAdded", type, record);
			return record;
		},

		addRecords: function(type, records){
			var _this = this;
			records.forEach(function(record){
				_this.addRecord(type, record);
			});
			return records;
		},

		removeRecord: function(type, id){
			if(!this._cache.retrieve([type, id])) return;

			this.transformCache({ op: 'remove', path: [type, id] });
			this.emit("recordRemoved", type, id);
		},

		addLink: function(type, typeId, link, linkId){
			console.log("firebase-cache.addLink", [type, typeId, link, linkId]);
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;

			if(linkType === "hasOne") return this.setHasOne(type, typeId, link, linkId);
			if(linkType === "hasMany") return this.addToHasMany(type, typeId, link, linkId);
			throw new Error("Link type not handled: " + linkType);
		},

		removeLink: function(type, typeId, link, linkId){
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;

			if(linkType === "hasOne") return this.setHasOne(type, typeId, link, null);
			if(linkType === "hasMany") return this.removeFromHasMany(type, typeId, link, linkId);
			throw new Error("Link type not handled: " + linkType);
		},

		setHasOne: function(type, typeId, link, linkId){
			if(this._cacheUtils.retrieveLink(type, typeId, link) === linkId) return;
			this.transformCache({ op: "add", path: [type, typeId, "__rel", link], value: linkId});
		},

		addToHasMany: function(type, typeId, link, linkId){
			var hasManyArray = Object.keys(this._cacheUtils.retrieveLink(type, typeId, link));
			debugger
			console.log("addToHasMany", hasManyArray, linkId);
			if(hasManyArray.indexOf(linkId) !== -1) return;
			this.transformCache({ op: "add", path: [type, typeId, "__rel", link, linkId], value: true});
		},

		removeFromHasMany: function(type, typeId, link, linkId){
			var hasManyArray = this._cacheUtils.retrieveLink(type, typeId, link);
			if(hasManyArray.indexOf(linkId) === -1) return;
			this.transformCache({ op: "remove", path: [type, typeId, "__rel", link, linkId] });
		},

		updateAttribute: function(type, typeId, attribute, value){
			var currentValue = this._cache.retrieve([type, typeId, attribute]);
			if(currentValue === value) return;
			this.transformCache({ op: "replace", path: [type, typeId, attribute], value: value });
		},

		updateMeta: function(type, typeId, meta, value){
			var currentValue = this._cache.retrieve([type, typeId, meta]);
			if(currentValue === value) return;
			this.transformCache({ op: "replace", path: [type, typeId, meta], value: value });	
		},

		updateLink: function(type, typeId, link, newValue){
			var _this = this,
				linkType = this._schemaUtils.lookupLinkDef(type, link).type,
				currentValue = this._cacheUtils.retrieveLink(type, typeId, link),
				cacheLinkPath = [type, typeId, "__rel", link];

			if(linkType === "hasOne"){
				if(newValue === currentValue) return;
				_this.transformCache({op: 'replace', path: cacheLinkPath, value: newValue});
			}
			else if(linkType === "hasMany"){
				var currentLinkIds = currentValue||[];
				var newLinkIds = newValue||[];

				var added = newLinkIds.filter(function(linkId){
					return currentLinkIds.indexOf(linkId) === -1;
				});

				var removed = currentLinkIds.filter(function(linkId){
					return newLinkIds.indexOf(linkId) === -1;
				});
				
				added.forEach(function(linkId){
					var path = cacheLinkPath.concat([linkId]);
					try{
						_this.transformCache({op: 'add', path: path, value: true});

					}
					catch(error){
						debugger
					}
				});

				removed.forEach(function(linkId){
					var path = cacheLinkPath.concat([linkId]);
					_this.transformCache({op: 'remove', path: path});
				});
			}		
		},

		transformCache: function(operation) {
			this.step += 1;
			console.log("t => " + operation.op + " " + operation.path.join("/") + " " + operation.value);

			// if(this.step % 100 === 1){
			// 	debugger
			// }

			this.validateOperation(operation);
			console.log("transformCache", operation);
			var pathToVerify,
			inverse;

			if (operation.op === 'add') {
				pathToVerify = operation.path.slice(0, operation.path.length - 1);
			} else {
				pathToVerify = operation.path;
			}

			if (this._cache.retrieve(pathToVerify)) {
		      	this._cache.transform(operation);

		  	} else if (operation.op === 'replace') {
		      	// try adding instead of replacing if the cache does not yet contain
		      	// the data
		      	operation.op = 'add';
		      	this.transformCache(operation);

		  	} else {
		      	// if the cache can't be transformed because, still trigger `didTransform`
		      	//
		      	// NOTE: this is not an error condition, since the local cache will often
		      	// be sparsely populated compared with the remote store
		      	// try {
		      		this._cache.transform(operation, []);
				// }
				// catch(error){
				// 	debugger
				// }	  	
		  	}
		},

		validateOperation: function(operation){
			var validOperations = ["add", "remove", "replace", "copy", "move", "test"];
			if(validOperations.indexOf(operation.op) === -1) throw new Error("Invalid operation: " + operation.op);
			if(operation.path[-1] === "_rel") throw new Error("Relationship not specified");
		},

		getId: function(type, data) {
			if (objects.isObject(data)) {
				return data[this._schema.models[type].primaryKey.name];
			} else {
				return data;
			}
		}
	});

});
define('orbit-firebase/firebase-client', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit-firebase/array-utils'], function (exports, objects, Orbit, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef){
			this.firebaseRef = firebaseRef;
		},

		set: function(path, value){
			path = this._normalizePath(path);

			console.log("firebase.set:" + path, value);
			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				console.log("setting:" + path, value);
				try{
					value = value || null; // undefined causes error in firebase client
					_this.firebaseRef.child(path).set(value, function(error){
						console.log(error);
						error ? reject(error) : resolve(value); // jshint ignore:line
					});
				}
				catch(error){
					debugger
				}
			});

		},

		push: function(path, value){
			var _this = this;
			return new Promise(function(resolve, reject){
				this.firebaseRef.child(path).push(value, function(error){
					if(error) {
						reject(error);
					}
					else {
						resolve();
					}
				});
			});
		},

		remove: function(path){
			var _this = this;
			var path = this._normalizePath(path);
			console.log("firebase.remove:", path);

			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).remove(function(error){
					error ? reject(error) : resolve(); // jshint ignore:line
				});
			});
		},

		removeFromArray: function(arrayPath, value){
			var _this = this;

			return this.valueAt(arrayPath).then(function(array){
				debugger
				if(!array) return;
				console.log(array);

				var index = array.indexOf(value);
				if(index === -1) return Orbit['default'].resolve();

				array.splice(index, 1);
				return _this.set(arrayPath, array);
			});
		},

		removeFromArrayAt: function(arrayPath, index){
			var _this = this;
			arrayPath = this._normalizePath(arrayPath);

			return this.valueAt(arrayPath).then(function(array){
				if(!array) return;

				array = array_utils.removeAt(array, index)
				return _this.set(arrayPath, array);
			});
		},		

		appendToArray: function(arrayPath, value){
			var _this = this;
			arrayPath = this._normalizePath(arrayPath);

			return _this.valueAt(arrayPath).then(function(array){
				array = array || [];
				if(array.indexOf(value) === -1){
					array.push(value);
				}
				return _this.set(arrayPath, array);	

			});
		},

		valueAt: function(path){
			var _this = this;
			path = this._normalizePath(path);

			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).once('value', function(snapshot){

					resolve(snapshot.val());

				}, function(error){
					reject(reject);
				});
			});
		},

	    _normalizePath: function(path) {
	    	return (typeof path === 'string') ? path : path.join('/');
	    },	
	});

});
define('orbit-firebase/firebase-operation-queues', ['exports', 'orbit/lib/objects', 'orbit/evented', 'orbit/operation'], function (exports, objects, Evented, Operation) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef, schema){
			Evented['default'].extend(this);
			this._firebaseRef = firebaseRef;
			this._subscriptions = {};
			this._receivedOperations = {};
			this._schema = schema;
		},

		subscribeToType: function(type){
			this._subscribeTo([type]);
		},

		subscribeToRecords: function(type, ids){
			var _this = this;
			ids.forEach(function(id){
				_this.subscribeToRecord(type, id);
			});
		},

		subscribeToRecord: function(type, id){
			this._subscribeTo([type, id]);
		},

		enqueue: function(operation){
			if(!operation.id) throw new Error("operation must have an id");
			console.log("op:" + operation.id + " fb-op-queues.enqueue", operation.serialize());

			var _this = this;
			var queues = this._queuesForOperation(operation);
			var serializedOperation = this._serializeOperation(operation);

			queues.forEach(function(queue){
				var queuePath = _this._queuePathFor(queue);
				console.log("sending", serializedOperation)
				_this._firebaseRef.child(queuePath).push(serializedOperation);
			});
		},

		unsubscribeAll: function(){
			var _this = this;
			Object.keys(this._subscriptions).forEach(function(queuePath){
				var callback = _this._subscriptions[queuePath];
				_this._firebaseRef.child(queuePath).orderByChild('date').limitToLast(1).off("child_added", callback);
			});
		},

		_queuesForOperation: function(operation){
			var path = (typeof operation.path === 'string') ? operation.path.split("/") : operation.path;
			return [
				[path[0]],
				[path[0], path[1]]
			];
		},

		_subscribeTo: function(path){
			var _this = this;
			var queuePath = this._queuePathFor(path);

			if(this._subscriptions[queuePath]) return;
			console.log("subscribing to", queuePath);

			var callbackReady = false;
			var callback = function(snapshot){
				var operation = _this._deserializeOperation(snapshot.val());
				// if(callbackReady){
					_this._emitDidTransform(operation);
				// }
				// else {
				// 	callbackReady = true; // discards first operation as we only want new children (by default firebase sends the last existing operation when the child_added listener is attached)
				// }
			}

			this._subscriptions[queuePath] = callback;

			this._firebaseRef.child(queuePath).orderByChild('date').limitToLast(1).on('child_added', callback);
		},

		_queuePathFor: function(path){
			var joinedPath = (typeof path === 'string') ? path : path.join("/");
			return "operation-queues/" + joinedPath + "/operations";
		},

		_serializeOperation: function(operation){		
			var serialized = {
				date: Firebase.ServerValue.TIMESTAMP,
				operation: JSON.stringify({ // firebase removes keys with null values, by stringifying the operation the keys are retained
					id: operation.id,
					op: operation.op,
					path: operation.path,
					value: operation.value||null,
					log: operation.log||null
				})
			}

			return serialized;
		},

		_deserializeOperation: function(serialized){
			return new Operation['default'](JSON.parse(serialized.operation));
		},

		_emitDidTransform: function(operation){
			if(!this._receivedOperations[operation.id]){
				this._receivedOperations[operation.id] = true;
				console.log("op:" + operation.id + " fb-op-queues._emitDidTransform", operation.serialize());
				this.emit("didTransform", operation);
			}
		}
	});

});
define('orbit-firebase/firebase-requester', ['exports', 'orbit/lib/objects', 'orbit-firebase/object-utils', 'orbit-firebase/schema-utils', 'orbit/main'], function (exports, objects, object_utils, SchemaUtils, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer){
			this._firebaseClient = firebaseClient;
			this._schema = schema;
			this._schemaUtils = new SchemaUtils['default'](schema);
			this._serializer = serializer;
		},

		find: function(type, id){
			return id ? this._findOne(type, id) : this._findAll(type);
		},

		findLink: function(type, id, link){
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;
			return this._firebaseClient.valueAt([type, id, link]).then(function(linkValue){
				if(linkType === 'hasMany') {
					return linkValue ? Object.keys(linkValue) : [];
				}
				else if(linkType === 'hasOne') {
					return linkValue;
				}
				throw new Error("Links of type " + linkType + " not handled");
			});
		},

		findLinked: function(type, id, link){
			var linkType = this._schemaUtils.lookupLinkDef(type, link).type;
			if(linkType === 'hasMany') {
				return this._findLinkedHasMany(type, id, link);
			}
			else if(linkType === 'hasOne') {
				return this._findLinkedHasOne(type, id, link);
			}
			throw new Error("Links of type " + linkType + " not handled");
		},

		_findOne: function(type, id){
			var _this = this;

			return _this._firebaseClient.valueAt([type, id]).then(function(record){
				// todo - is this the correct behaviour for not found?
				if(!record) return record;
				return _this._serializer.deserialize(type, id, record);
			});
		},

		_findAll: function(type){
			var _this = this;
			return _this._firebaseClient.valueAt(type).then(function(recordsHash){
				var records = object_utils.objectValues(recordsHash);
				console.log("findAll results for: " + type, records);
				return _this._serializer.deserializeRecords(type, records);
			});
		},

		_findLinkedHasMany: function(type, id, link){
			var _this = this;
			var linkDef = this._schemaUtils.lookupLinkDef(type, link);
			var model = linkDef.model;

			return this.findLink(type, id, link).then(function(ids){
				var promised = [];
				for(var i = 0; i < ids.length; i++){
					promised[i] = _this._firebaseClient.valueAt([model, ids[i]]);
				}

				return Orbit['default'].map(promised, function(record){
					return _this._serializer.deserialize(model, record.id, record);
				});
			});
		},

		_findLinkedHasOne: function(type, id, link){
			var _this = this;
			var linkDef = this._schemaUtils.lookupLinkDef(type, link);
			var model = linkDef.model;

			return this.findLink(type, id, link).then(function(id){
				return _this._firebaseClient.valueAt([model, id]).then(function(serializedRecord){
					return _this._serializer.deserialize(model, id, serializedRecord);
				});
			});
		}
	});

});
define('orbit-firebase/firebase-serializer', ['exports', 'orbit-common/serializer', 'orbit/lib/objects', 'orbit/lib/assert'], function (exports, Serializer, objects, assert) {

	'use strict';

	exports['default'] = Serializer['default'].extend({
		serialize: function(type, records){
			return this.serializeRecord(type, records);
		},

		serializeRecord: function(type, record) {
			assert.assert(record, "Must provide a record");

			var json = {};

			this.serializeKeys(type, record, json);
			this.serializeAttributes(type, record, json);
			this.serializeLinks(type, record, json);

			return json;
		},

		serializeKeys: function(type, record, json) {
			var modelSchema = this.schema.models[type];
			var resourceKey = this.resourceKey(type);
			var value = record[resourceKey];

			if (value) {
				json[resourceKey] = value;
			}
		},

		serializeAttributes: function(type, record, json) {
			var modelSchema = this.schema.models[type];

			Object.keys(modelSchema.attributes).forEach(function(attr) {
				this.serializeAttribute(type, record, attr, json);
			}, this);
		},

		serializeAttribute: function(type, record, attr, json) {
			json[this.resourceAttr(type, attr)] = record[attr];
		},

		serializeLinks: function(type, record, json) {
			var modelSchema = this.schema.models[type];
			var linkNames = Object.keys(modelSchema.links);

			linkNames.forEach(function(link){
				var linkDef = modelSchema.links[link];
				var value = record.__rel[link];

				if(linkDef.type === 'hasMany'){
					json[link] = Object.keys(value||{});
				}
				else {
					json[link] = value;
				}
			});
		},

		deserializeRecords: function(type, records){
			var _this = this;
			return records.map(function(record){
				return _this.deserialize(type, record.id, record);
			});
		},

		deserialize: function(type, id, record){
			record = record || {};
			var data = {};

			this.deserializeKeys(type, id, record, data);
			this.deserializeAttributes(type, record, data);
			this.deserializeLinks(type, record, data);

			return data;
		},

		deserializeKeys: function(type, id, record, data){
			data[this.schema.models[type].primaryKey.name] = id;
			data.__id = id;
			data.id = id;
		},

		deserializeAttributes: function(type, record, data){
			var modelSchema = this.schema.models[type];

			Object.keys(modelSchema.attributes).forEach(function(attr) {
				this.deserializeAttribute(type, record, attr, data);
			}, this);
		},

		deserializeAttribute: function(type, record, attr, data){
			data[attr] = record[attr] || null; // firebase doesn't like 'undefined' so replace with null
		},

		deserializeLinks: function(type, record, data){
			var _this = this;
			var modelSchema = this.schema.models[type];
			data.__rel = {};

			Object.keys(modelSchema.links).forEach(function(link) {
				var linkDef = modelSchema.links[link];
				var value = record[link]||{};

				// if(linkDef.type === "hasMany"){
				// 	value = _this.buildHash(value||[], true)
				// }

				data.__rel[link] = value;
			});
		},

		buildHash: function(keys, value){
			if(!objects.isArray(keys)){
				debugger
			}
			var hash = {};
			
			keys.forEach(function(key){
				hash[key] = value;
			});

			return hash;
		},

		resourceKey: function(type) {
			return 'id';
		},	

		resourceType: function(type) {
			return this.schema.pluralize(type);
		},

		resourceLink: function(type, link) {
			return link;
		},

		resourceAttr: function(type, attr) {
			return attr;
		}
	});

});
define('orbit-firebase/firebase-source', ['exports', 'orbit/lib/objects', 'orbit/main', 'orbit/lib/assert', 'orbit-common/source', 'orbit-firebase/object-utils', 'orbit/transform-connector', 'orbit/transformable', 'orbit/operation', 'orbit-firebase/firebase-client', 'orbit-firebase/firebase-requester', 'orbit-firebase/firebase-transformer', 'orbit-firebase/firebase-serializer', 'orbit-firebase/firebase-operation-queues', 'orbit-firebase/firebase-utils', 'orbit-firebase/firebase-cache', 'orbit-firebase/operation-matcher', 'orbit-firebase/operation-decomposer', 'orbit-firebase/schema-utils'], function (exports, objects, Orbit, assert, Source, object_utils, TransformConnector, Transformable, Operation, FirebaseClient, FirebaseRequester, FirebaseTransformer, FirebaseSerializer, FirebaseOperationQueues, FirebaseUtils, FirebaseCache, OperationMatcher, OperationDecomposer, SchemaUtils) {

	'use strict';

	var CacheSource = objects.Class.extend({
		init: function(cache){
			Transformable['default'].extend(this);
			this._cache = cache;
			objects.expose(this, this._cache, ['retrieve']);
		},

		_transform: function(operations){
			var _this = this;
			operations = objects.isArray(operations) ? operations : [operations];

			operations.forEach(function(operation){
				_this._cache.transform(operation);
			});

			this.settleTransforms();
		}
	});


	exports['default'] = Source['default'].extend({
		notifierName: "firebase-source",

		init: function(schema, options){
			var _this = this,
				options = options || {};

			this._super.apply(this, arguments);
			window.firebaseSource = this;

			assert.assert('FirebaseSource requires Orbit.Promise be defined', Orbit['default'].Promise);
			assert.assert('FirebaseSource requires Orbit.all be defined', Orbit['default'].all);
			assert.assert('FirebaseSource requires Orbit.map be defined', Orbit['default'].map);
			assert.assert('FirebaseSource requires Orbit.resolve be defined', Orbit['default'].resolve);
			assert.assert('FirebaseSource requires firebaseRef be defined', options.firebaseRef);

			window.firebaseSource = this;

			var firebaseRef = options.firebaseRef;
			var serializer = new FirebaseSerializer['default'](schema);
			var firebaseClient = new FirebaseClient['default'](firebaseRef);

			this._firebaseTransformer = new FirebaseTransformer['default'](firebaseClient, schema, serializer);
			this._firebaseRequester = new FirebaseRequester['default'](firebaseClient, schema, serializer);
			this._firebaseOperationQueues = new FirebaseOperationQueues['default'](firebaseRef, schema);
			this._firebaseOperationQueues.id = "firebaseOperationQueues";

			var cacheSource = new CacheSource(this._cache);
			cacheSource.id = "cacheSource";
			var connector = new TransformConnector['default'](this._firebaseOperationQueues, cacheSource);
			connector.id = "fromFirebase";
			this._cache.on("didTransform", function(operation){
				console.log("**** cacheDidTransform", operation);
			})
		},

		_transform: function(operation){
			var _this = this;

			return this._firebaseTransformer.transform(operation).then(function(result){

				if(operation.op === "add" && operation.path.length === 2){
					var type = operation.path[0];
					_this._subscribeToRecords(type, result);
				}

				if(operation.op !== "remove" && operation.path.length === 2){
					operation.value = _this.schema.normalize(operation.path[0], operation.value);
				}

				_this._firebaseOperationQueues.enqueue(operation);
			});
		},

		_find: function(type, id){
			var _this = this;
			return this._firebaseRequester.find(type, id).then(function(records){
				if(!id) _this._firebaseOperationQueues.subscribeToType(type);
				_this._subscribeToRecords(type, records);
				return _this._addRecordsToCache(type, records);
			});
		},

		_findLink: function(type, id, link){
			return this._firebaseRequester.findLink(type, id, link);
		},

		_findLinked: function(type, id, link){
			var _this = this,
				linkedType = this.schema.models[type].links[link].model;

			return this._firebaseRequester.findLinked(type, id, link).then(function(records){
				_this._subscribeToRecords(linkedType, records);
				return _this._addRecordsToCache(linkedType, records);
			});
		},

		_subscribeToRecords: function(type, records){
			records = objects.isArray(records) ? records : [records];
			this._firebaseOperationQueues.subscribeToRecords(type, object_utils.pluck(records, 'id'));
		},

		_addRecordsToCache: function(type, recordOrRecords) {
			console.log("addingRecordsToCache", recordOrRecords);
			var _this = this;
			var records = objects.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];

			var promisedRecords = object_utils.reduce(records, function(record) {
				_this._addRecordToCache(type, record);
			});

			console.log("calling settleTransforms from firebase-souce");
			return this.settleTransforms().then(function(){
				return recordOrRecords;
			});
		},

		_addRecordToCache: function(type, record) {
			console.log('op:' + record.id, "fb-source._addRecordToCache");
			console.log("adding record to cache", record);
			var operation = new Operation['default']({
				op: 'add',
				path: [type, record.id],
				value: record
			});

			this._cache.transform(operation);
		},
	});

});
define('orbit-firebase/firebase-transformer', ['exports', 'orbit/lib/objects', 'orbit-firebase/transformers/add-record', 'orbit-firebase/transformers/remove-record', 'orbit-firebase/transformers/replace-attribute', 'orbit-firebase/transformers/add-to-has-many', 'orbit-firebase/transformers/add-to-has-one', 'orbit-firebase/transformers/remove-has-one', 'orbit-firebase/transformers/replace-has-many', 'orbit-firebase/transformers/remove-from-has-many', 'orbit-firebase/transformers/update-meta'], function (exports, objects, AddRecord, RemoveRecord, ReplaceAttribute, AddToHasMany, AddToHasOne, RemoveHasOne, ReplaceHasMany, RemoveFromHasMany, UpdateMeta) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer, cache){
			this._schema = schema;

			this._transformers = [
				new AddRecord['default'](firebaseClient, schema, serializer),
				new RemoveRecord['default'](firebaseClient),
				new ReplaceAttribute['default'](firebaseClient),
				new AddToHasMany['default'](firebaseClient, schema),
				new AddToHasOne['default'](firebaseClient, schema),
				new RemoveHasOne['default'](firebaseClient, schema),
				new ReplaceHasMany['default'](firebaseClient, schema),
				new RemoveFromHasMany['default'](firebaseClient, schema),
				new UpdateMeta['default'](cache)
			];
		},

		transform: function(operation){
			this._normalizeOperation(operation);
			var transformer = this._findTransformer(operation);
			return transformer.transform(operation);
		},

	    _normalizeOperation: function(op) {
	      if (typeof op.path === 'string') {
	      	op.path = op.path.split('/');
	      }
	    },

		_findTransformer: function(operation){
			for(var i = 0; i < this._transformers.length; i++){
				var transformer = this._transformers[i];

				if(transformer.handles(operation)) {
					console.log("using transformer", transformer);
					return transformer;
				}
			}

			throw new Error("Couldn't find a transformer for: " + JSON.stringify(operation));
		}
	});

});
define('orbit-firebase/firebase-utils', ['exports', 'orbit/lib/objects', 'orbit/main'], function (exports, objects, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseRef, schema, serializer){
			this.firebaseRef = firebaseRef;
			this._schema = schema;
			this._serializer = serializer;
		},

		addRecord: function(type, id, record){
			var path = [type, id].join("/");

			if(!record.id) {
				throw new Error("Tried to add a watch for a record with no id: " + JSON.stringify(record));
			}
			if(record.id === "true"){
				throw new Error("Tried to add a watch for a record with an id of 'true': " + JSON.stringify(record));
			}

			return this.set(path, record);
		},

		removeRecord: function(type, id){
			var path = [type, id].join("/");
			return this.remove(path);
		},

		addLink: function(type, typeId, link, linkId){
			var linkDef = this._schema.models[type].links[link];
			var firepath = [type, typeId, link].join("/");
			if(linkDef.type === "hasMany") return this.appendToArray(firepath, linkId);
			if(linkDef.type === "hasOne") return this.set(firepath, linkId);
			throw new Error("No addLink handler for link type: " + linkDef.type);
		},

		removeLink: function(type, typeId, link, linkId){
			var linkDef = this._schema.models[type].links[link];
			var firepath = [type, typeId, link].join("/");
			if(linkDef.type === "hasMany") return this.removeFromArray(firepath, linkId);
			if(linkDef.type === "hasOne") return this.set(firepath, null);
			throw new Error("No removeLink handler for link type: " + linkDef.type);
		},

		replaceLink: function(type, typeId, link, linkValue){
			var firepath = [type, typeId, link].join("/");
			return this.set(firepath, linkValue);
		},

		updateAttribute: function(type, typeId, attribute, value){
			var path = [type, typeId, attribute].join("/");
			return this.set(path, value);
		},

		findOne: function(type, id){
			var _this = this;
			var path = [type, id].join("/");
			return _this.valueAt(path).then(function(record){
				// todo - is this the correct behaviour for not found?
				if(!record) return record;
				var deserialized = _this._serializer.deserialize(type, id, record);
				return deserialized;
			});
		},

		findAll: function(type){
			var _this = this;
			return _this.valueAt(type).then(function(recordsHash){
				var records = _this.objectValues(recordsHash);
				var deserialized = _this._serializer.deserializeRecords(type, records);
				return deserialized;
			});
		},

		objectValues: function(object){
			if(!object) return [];
			return Object.keys(object).map(function(key){
				return object[key];
			});
		},

		set: function(path, value){
			console.log("firebase.set:" + path, value);
			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				console.log("setting:" + path, value);
				try{
					value = value || null; // undefined causes error in firebase client
					_this.firebaseRef.child(path).set(value, function(error){
						error ? reject(error) : resolve(value); // jshint ignore:line
					});
				}
				catch(error){
					debugger
				}
			});

		},

		remove: function(path){
			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).remove(function(error){
					error ? reject(error) : resolve(); // jshint ignore:line
				});
			});
		},

		removeFromArray: function(arrayPath, value){
			var _this = this;

			return this.valueAt(arrayPath).then(function(array){
				if(!array) return;

				var index = array.indexOf(value);
				if(index === -1) return Orbit['default'].resolve();

				array.splice(index, 1);
				return _this.set(arrayPath, array);
			});
		},

		appendToArray: function(arrayPath, value){
			var _this = this;
			return _this.valueAt(arrayPath).then(function(array){
				array = array || [];
				if(array.indexOf(value) === -1){
					array.push(value);
				}
				return _this.set(arrayPath, array);	

			});
		},

		valueAt: function(path){
			var _this = this;
			return new Orbit['default'].Promise(function(resolve, reject){
				_this.firebaseRef.child(path).once('value', function(snapshot){

					resolve(snapshot.val());

				}, function(error){
					reject(reject);
				});
			});
		}
	});

});
define('orbit-firebase/object-utils', ['exports'], function (exports) {

	'use strict';

	exports.objectValues = objectValues;
	exports.pluck = pluck;
	exports.reduce = reduce;

	function objectValues(object){
		if(!object) return [];
		return Object.keys(object).map(function(key){
			return object[key];
		});
	}

	function reduce(array, callback){
		var reduced = [];

		for(var i = 0; i < array.length; i++){
			reduced[i] = callback(array[i]);
		}

		return reduced;
	}

	function pluck(array, property){
		return reduce(array, function(item){
			return item[property];
		});
	}

});
define('orbit-firebase/operation-decomposer', ['exports', 'orbit/lib/objects', 'orbit-firebase/operation-matcher', 'orbit-firebase/schema-utils', 'orbit-firebase/cache-utils', 'orbit/operation'], function (exports, objects, OperationMatcher, SchemaUtils, CacheUtils, Operation) {

	'use strict';

	function asHash(k,v){
	  var hash = {};
	  hash[k] = v;
	  return hash;
	}

	function buildObject(keys, value){
		var hash = {};
		keys.forEach(function(key){
			hash[key] = value;
		});
		return hash;
	}

	var ChangeDetails = objects.Class.extend({
		init: function(path, value, schema, cache){
			this.path = path;
			this.value = value;
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);		
			this.cache = cache;
		},

		model: function(){
			return this.path[0];
		},

		modelId: function(){
			return this.path[1];
		},

		link: function(){
			return this.path[3];
		},

		currentValue: function(){
			return this.cache.retrieve(this.path);
		},

		linkDef: function(){
			return this.schemaUtils.lookupLinkDef(this.model(), this.link());
		},

		originalInversePath: function(){
			return [this.linkDef().model, this.currentValue(), "__rel", this.linkDef().inverse];
		},

		inverseLinkDef: function(){
			return this.schemaUtils.lookupRelatedLinkDef(this.model(), this.link());
		},

		newInversePath: function(){
			return [this.linkDef().model, this.value, "__rel", this.linkDef().inverse];
		}
	});

	var RelationshipResolver = objects.Class.extend({
		init: function(schema, cache){
			this.visited = [];
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);
			this.cache = cache;
			this.cacheUtils = new CacheUtils['default'](cache);		
			this.operations = [];
		},

		visit: function(op, path, value){
			if(this.hasVisited(path)) return;
			this.markVisited(path);

			console.log("visiting", [op, path, value].join("|"));
			var linkType = this.schemaUtils.linkTypeFor(path[0], path[3]);
			console.log("visiting", [linkType, op, path, value].join("|"));

			if(!path[1]) throw new Error("invalid modelId: " + op + "|" + path + "|" + value);

			this[linkType][op].call(this, path, value);
		},

		hasVisited: function(path){
			return this.visited.indexOf(path.join("/")) !== -1;
		},

		markVisited: function(path){
			this.visited.push(path.join("/"));
		},

		hasOne: {
			add: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);

				this.operations.push(new Operation['default']({ op: 'add', path: changeDetails.path, value: changeDetails.value }));
				if(changeDetails.currentValue()){
					this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
				}
				this.visit("add", changeDetails.newInversePath(), changeDetails.modelId());
			},

			remove: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);
				if(!value) return;
				this.operations.push(new Operation['default']({ op: 'remove', path: changeDetails.path}));
				this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
			},

			replace: function(path, value){
				var changeDetails = new ChangeDetails(path, value, this.schema, this.cache);

				this.operations.push(new Operation['default']({ op: 'replace', path: changeDetails.path, value: changeDetails.value }));
				if(changeDetails.currentValue()){
					this.visit("remove", changeDetails.originalInversePath(), changeDetails.modelId());
				}
				this.visit("add", changeDetails.newInversePath(), changeDetails.modelId());
			}
		},

		hasMany: {
			add: function(path, value){

				var linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				var inversePath = [linkDef.model, value, "__rel", linkDef.inverse];

				this.operations.push(new Operation['default']({ op: 'add', path: path.concat(value), value: true }));
				this.visit("add", inversePath, path[1]);
			},

			remove: function(path, value){
				var linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				var inversePath = [linkDef.model, value, "__rel", linkDef.inverse];
				this.operations.push(new Operation['default']({ op: 'remove', path: path.concat(value) }));
				this.visit("remove", inversePath, path[1]);
			},

			replace: function(path, value){
				var _this = this,
					relatedLinkDef = this.schemaUtils.lookupRelatedLinkDef(path[0], path[3]);

				this.operations.push(new Operation['default']({ op: 'replace', path: path, value: buildObject(value, true) }));
				
				if(relatedLinkDef.type === 'hasMany') return;

				var linkValue = this.cache.retrieve(path),
					currentValue = linkValue ? Object.keys(linkValue) : [],
					modelId = path[1],
					linkDef = this.schemaUtils.lookupLinkDef(path[0], path[3]);
				
				var added = value.filter(function(id){
					return currentValue.indexOf(id) === -1;
				});
				var removed = currentValue.filter(function(id){
					return value.indexOf(id) === -1;
				});

				added.forEach(function(id){
					var inversePath = [linkDef.model, id, "__rel", linkDef.inverse];
					_this.visit("add", inversePath, modelId);
				});

				removed.forEach(function(id){
					var inversePath = [linkDef.model, id, "__rel", linkDef.inverse];
					_this.visit("remove", inversePath, modelId);
				});
			}
		}
	});

	exports['default'] = objects.Class.extend({
		init: function(schema, cache){
			this.schema = schema;
			this.schemaUtils = new SchemaUtils['default'](schema);
			this.cache = cache;
			this.cacheUtils = new CacheUtils['default'](cache);
		},

		decompose: function(operation){
			if(operation.path[2] !== "__rel") return [operation];
			console.log("decomposing", [operation.op, operation.path.join("/"), operation.value].join(", "));
			var relationshipResolver = new RelationshipResolver(this.schema, this.cache);
			console.log("original", operation);
			var normalized = this.normalize(operation);
			console.log("normalized", normalized);
			relationshipResolver.visit(normalized.op, normalized.path, normalized.value);
			return relationshipResolver.operations;
		},

		normalize: function(operation){
			var linkDef = this.schemaUtils.lookupLinkDef(operation.path[0], operation.path[3]);
			var path = operation.path;

			if(["hasMany", "hasOne"].indexOf(linkDef.type) === -1) throw new Error("unsupported link type: " + linkDef.type);

			if(linkDef.type === "hasOne" && operation.op === "add") return operation;
			if(linkDef.type === "hasOne" && operation.op === "remove"){
				return {
					op: operation.op, 
					path: path, 
					value: this.cache.retrieve(path)
				}
			}
			if(linkDef.type === "hasMany" && (['add', 'remove'].indexOf(operation.op) !== -1)) {
				return { 
					op: operation.op, 
					path: path.slice(0,-1), 
					value: path[path.length-1] 
				};
			}
			if(linkDef.type === "hasMany" && operation.op === "replace"){
				return {
					op: operation.op,
					path: operation.path,
					value: Object.keys(operation.value)	
				}
			}
			return operation;
		}
	});

});
define('orbit-firebase/operation-matcher', ['exports', 'orbit/lib/objects', 'orbit/lib/assert'], function (exports, objects, assert) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(operation, schema){
			assert.assert('OperationMatcher requires the operation', operation);
			assert.assert('OperationMatcher requires the schema', schema && schema.models);

			this.valueType = this._determineValueType(operation.path, schema);
			this.op = operation.op;
			this.schema = schema;
		},

		matches: function(op, valueType){
			return this.op === op && this.valueType === valueType;
		},

		_determineValueType: function(path, schema){
			try {
				if(path.length === 1) return 'type';
				if(path.length === 2) return 'record';
				if(path.length === 5) return 'link';
				if(path.length === 4 && path[2] === "__rel") return 'link';
				if(path[2].match(/^__/)) return "meta";

				var model = schema.models[path[0]];
				var key = path[2];
				if(model.attributes[key]) return 'attribute';
				if(model.keys[key]) return 'key';
				throw "Unable to determine value type at: " + path.join("/");
			}
			catch(error){
				debugger
			}
		},	
	});

});
define('orbit-firebase/schema-utils', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(schema){
			this.schema = schema;
		},

		lookupLinkDef: function(model, link){
			var modelSchema = this.schema.models[model];
			if(!modelSchema) debugger;
			var linkDef = modelSchema.links[link];
			if(!linkDef) debugger;//throw "Unable to find linkDef for: " + [model, link].join("/");
			return linkDef;
		},

		lookupRelatedLinkDef: function(model, link){
			var linkDef = this.lookupLinkDef(model, link);
			return this.schema.models[linkDef.model].links[linkDef.inverse];
		},

		linkTypeFor: function(model, link){
			var linkDef = this.lookupLinkDef(model, link);
			if(!linkDef) throw new Error("Could not find type for " + model + "/" + link);
			return linkDef.type;
		}
	});

});
define('orbit-firebase/transformers/add-record', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema, serializer){
			this._firebaseClient = firebaseClient;
			this._schema = schema;
			this._serializer = serializer;
		},

		handles: function(operation){
			return operation.op === "add" && operation.path.length === 2;
		},

		transform: function(operation){
			var model = operation.path[0];
			var record = this._schema.normalize(model, operation.value);
			var serializedRecord = this._serializer.serializeRecord(model, record);

			return this._firebaseClient.set(operation.path, serializedRecord);
		}
	});

});
define('orbit-firebase/transformers/add-to-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return; 
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "add" && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.appendToArray(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/add-to-has-one', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return ["add", "replace"].indexOf(operation.op) !== -1 && path[2] === '__rel' && linkType === 'hasOne';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.set(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/remove-from-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "remove" && path[2] === '__rel' && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.remove(path);
		}
	});

});
define('orbit-firebase/transformers/remove-has-one', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "remove" && path[2] === '__rel' && linkType === 'hasOne';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.remove(path);
		}
	});

});
define('orbit-firebase/transformers/remove-record', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient){
			this._firebaseClient = firebaseClient;
		},

		handles: function(operation){
			return operation.op === "remove" && operation.path.length === 2;
		},

		transform: function(operation){
			return this._firebaseClient.set(operation.path, null);
		}
	});

});
define('orbit-firebase/transformers/replace-attribute', ['exports', 'orbit/lib/objects'], function (exports, objects) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient){
			this._firebaseClient = firebaseClient;
		},

		handles: function(operation){
			return ["replace", "add"].indexOf(operation.op) !== -1 && operation.path.length === 3 && !operation.path[2].match(/^__/);
		},

		transform: function(operation){
			return this._firebaseClient.set(operation.path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/replace-has-many', ['exports', 'orbit/lib/objects', 'orbit-firebase/schema-utils', 'orbit-firebase/array-utils'], function (exports, objects, SchemaUtils, array_utils) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(firebaseClient, schema){
			this._firebaseClient = firebaseClient;
			this._schemaUtils = new SchemaUtils['default'](schema);
		},

		handles: function(operation){
			var path = operation.path;
			if(path[2] !== '__rel') return;
			var linkType = this._schemaUtils.lookupLinkDef(path[0], path[3]).type;
			return operation.op === "replace" && path[2] === '__rel' && linkType === 'hasMany';
		},

		transform: function(operation){
			var path = array_utils.removeItem(operation.path, '__rel');
			return this._firebaseClient.set(path, operation.value);
		}
	});

});
define('orbit-firebase/transformers/update-meta', ['exports', 'orbit/lib/objects', 'orbit/main'], function (exports, objects, Orbit) {

	'use strict';

	exports['default'] = objects.Class.extend({
		init: function(cache){
			this._cache = cache;
		},

		handles: function(operation){
			return operation.path[2].match(/^__/);
		},

		transform: function(operation){
			console.log("applying to cache", operation);
			this._cache.transform(operation);				
			console.log("applied to cache", operation);
			return Orbit['default'].resolve();
		}
	});

});//# sourceMappingURL=orbit-firebase.amd.map