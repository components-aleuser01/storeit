"use strict";

var _ = require("underscore");
var pubit = require("pubit-as-promised");
var publishLogger = require("./utils").publishLogger;
var whatsDifferent = require("./utils").whatsDifferent;
var isObject = require("./utils").isObject;
var cloneObject = require("./utils").cloneObject;
var isEqual = require("./utils").isEqual;

var NS_SEPARATOR_CHAR = "#";

var events = ["added", "modified", "removed", "cleared"];

var Action = {
    none: 0,
    added: 1,
    modified: 2,
    removed: 3
};

function throwUninitializedError() {
    throw new Error("[Storeit] you must first call `load`");
}

function Storeit(namespace, storageProvider, logger) {
    var that = this;
    var cache = {};

    if (namespace.indexOf(NS_SEPARATOR_CHAR) !== -1) {
        throw new Error("[Storeit] namespace can not contain a hash character (#)");
    }

    var options = { // Defaut options.
        publish: true,
        publishRemoveOnClear: false
    };

    var publish = pubit.makeEmitter(that, events); // Mixin `on`, `off`, `once`.
    publish = publishLogger(publish, logger || _.noop, namespace); // Make the logger function optional.
    var originalPublish = publish;

    var throwIfUninitialized = throwUninitializedError; // Default until `load` is called.

    function typeCheckKey(key) {
        throwIfUninitialized();
        if (typeof key !== "string") {
            throw new TypeError("[Storeit] key must be a string.");
        }
    }

    function nskey(key, modifier) {
        return namespace + (modifier ? NS_SEPARATOR_CHAR + modifier : "") + ":" + key;
    }

    function ikey(key) {
        return nskey(key, "index"); // ex: mynamespace#index:primary
    }

    function mkey(key) {
        return nskey(key, "metadata"); // ex: mynamespace#metadata:123
    }

    function has(key) {
        typeCheckKey(key);
        return key in cache;
    }

    function getValue(key) {
        return cache[key].value;
    }

    function deleteKey(key) {
        var value = getValue(key);
        delete cache[key];
        storageProvider.removeItem(nskey(key));
        storageProvider.removeItem(mkey(key));
        publish("removed", value, key);
        return value;
    }

    function setMetadata(key, value) {
        cache[key].metadata = value;
        storageProvider.setItem(mkey(key), value);
    }

    function set(key, value) {
        var results = {};
        if (has(key)) {
            var partial = value;
            var currentValue = getValue(key);
            if (isObject(value) && isObject(currentValue)) {
                value = _.extend(cloneObject(currentValue), value); // Allow "patching" with partial value.
                partial = whatsDifferent(currentValue, value);
            }
            if (isEqual(currentValue, value)) {
                results.action = Action.none;
            } else {
                cache[key].value = value;
                publish("modified", partial, key);
                results.action = Action.modified;
            }
        } else {
            cache[key] = {
                value: value,
                metadata: null
            };
            publish("added", cloneObject(value), key);
            results.action = Action.added;
        }
        results.key = key;
        results.value = value;
        return results;
    }

    function getIndex() {
        return storageProvider.getMetadata(ikey("primary")) || [];
    }

    function setIndex() {
        var keys = Object.keys(cache);
        storageProvider.setMetadata(ikey("primary"), keys);
    }

    function getAllFilteredByProperty(propName, propValue) {
        throwIfUninitialized();
        var results = [];
        Object.keys(cache).forEach(function (key) {
            var value = getValue(key);
            if (!propName || value[propName] === propValue) {
                results.push(value);
            }
        });
        return results;
    }

    // Read in the base namespace key
    function initializeItemSerializer(hasItems) {
        // Is there is a itemSerializer specified, we MUST use it.
        // If existing data and no itemSerializer specified, this is an old JSON database,
        // so "fake" the compatible JSON serializer
        var providerInfo = storageProvider.getMetadata(namespace); // TODO I hate this!
        var itemSerializerName = providerInfo ? providerInfo.itemSerializer :
            hasItems ? "JSONSerializer" : null;
        storageProvider.itemSerializer = itemSerializerName;
    }

    function setSerializerName() {
        var data = {
            itemSerializer: storageProvider.itemSerializer
        };
        storageProvider.setMetadata(namespace, data);
    }

    that.has = has;

    that.get = function (key, defaultValue) {
        return has(key) ? getValue(key) : defaultValue;
    };

    that.getAll = function () {
        return getAllFilteredByProperty();
    };

    that.getAllFilteredByProperty = getAllFilteredByProperty;

    that.metadata = function (key) {
        if (has(key)) {
            return {
                set: function (value) {
                    if (typeof value === "undefined") {
                        throw new TypeError("[Storeit] metadata value must not be undefined.");
                    }
                    setMetadata(key, value);
                },
                get: function () {
                    return cache[key].metadata;
                }
            };
        } else {
            throw new Error("[Storeit.metadata] key doesn't exist");
        }
    };

    that.set = function (key, value, metadata) {
        if (typeof value === "undefined") {
            throw new TypeError("[Storeit] value must not be undefined.");
        }
        var results = set(key, value, metadata);
        if (results.action === Action.added) {
            setSerializerName();
            setIndex();
        }
        if (results.action !== Action.none) {
            storageProvider.setItem(nskey(key), results.value);
        }
        if (metadata !== undefined) {
            setMetadata(key, metadata);
            results.metadata = metadata;
        }
        return results;
    };

    that.delete = function (key) {
        if (has(key)) {
            var deletedValue = deleteKey(key);
            setIndex();
            return {
                action: Action.removed,
                key: key,
                value: deletedValue
            };
        } else {
            throw new Error("[Storeit.delete] key doesn't exist");
        }
    };

    that.forEach = function (fun) {
        throwIfUninitialized();
        Object.keys(cache).forEach(function (key) {
            fun(key, getValue(key));
        });
    };

    that.clear = function () {
        throwIfUninitialized();
        if (options.publishRemoveOnClear) { // Publish removed events only for things that the domain knows about.
            Object.keys(cache).reverse().forEach(deleteKey);
        }
        getIndex().forEach(function (key) { // Remove everything from provider, loaded or not.
            storageProvider.removeItem(nskey(key));
            storageProvider.removeItem(mkey(key));
        });
        cache = {};
        storageProvider.removeItem(ikey("primary"));
        storageProvider.removeItem(namespace); // Remove the storageMetadata for the namespace.
        publish("cleared");
    };

    Object.defineProperty(that, "options", {
        get: function () {
            return options;
        },
        set: function (value) {
            _.extend(options, value);
            publish = options.publish ? originalPublish : _.noop;
        },
        enumerable: true
    });

    Object.defineProperty(that, "keys", {
        get: function () {
            throwIfUninitialized();
            return Object.keys(cache);
        },
        enumerable: true
    });

    Object.defineProperty(that, "namespace", {
        value: namespace,
        enumerable: true
    });

    that.load = function () {
        throwIfUninitialized = _.noop; // Allow other methods to work without throwing.
        var index = getIndex();
        initializeItemSerializer(!!index.length);
        index.forEach(function (key) { // For each key in "namespace#index:primary"...
            var value = storageProvider.getItem(nskey(key));
            set(key, value); // Build cache and publish an "added" events.
        });
    };

}

Storeit.Action = Action;

module.exports = Storeit;