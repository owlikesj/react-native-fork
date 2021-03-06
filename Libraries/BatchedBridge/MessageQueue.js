/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule MessageQueue
 * @flow
 * @format
 */

/*eslint no-bitwise: 0*/

'use strict';

const ErrorUtils = require('ErrorUtils');
const Systrace = require('Systrace');

const deepFreezeAndThrowOnMutationInDev = require('deepFreezeAndThrowOnMutationInDev');
const invariant = require('fbjs/lib/invariant');
const stringifySafe = require('stringifySafe');

export type SpyData = {
  type: number,
  module: ?string,
  method: string | number,
  isSync: boolean,
  successCbId: number,
  failCbId: number,
  args: Array<any>,
  returnValue?: any,
};

const TO_JS = 0;
const TO_NATIVE = 1;

const MODULE_IDS = 0;
const METHOD_IDS = 1;
const PARAMS = 2;
const MIN_TIME_BETWEEN_FLUSHES_MS = 5;

const TRACE_TAG_REACT_APPS = 1 << 17;

const DEBUG_INFO_LIMIT = 64;

// Work around an initialization order issue
let JSTimers = null;

class MessageQueue {
  _lazyCallableModules: {[key: string]: (void) => Object};
  _queue: [Array<number>, Array<number>, Array<any>, number];
  _successCallbacks: Array<?Function>;
  _failureCallbacks: Array<?Function>;
  _callID: number;
  _inCall: number;
  _lastFlush: number;
  _eventLoopStartTime: number;

  _debugInfo: Object;
  _remoteModuleTable: Object;
  _remoteMethodTable: Object;

  __spy: ?(data: SpyData) => void;

  constructor() {
    this._lazyCallableModules = {};
    this._queue = [[], [], [], 0];
    this._successCallbacks = [];
    this._failureCallbacks = [];
    this._callID = 0;
    this._lastFlush = 0;
    this._eventLoopStartTime = new Date().getTime();

    if (__DEV__) {
      this._debugInfo = {};
      this._remoteModuleTable = {};
      this._remoteMethodTable = {};
    }
  }

  /**
   * Public APIs
   */
  static spy(spyOrToggle: boolean | ((data: SpyData) => void)) {
    if (spyOrToggle === true) {
      MessageQueue.prototype.__spy = info => {
        console.log(
          `${info.type === TO_JS ? 'N->JS' : 'JS->N'} : ` +
            `${info.module ? info.module + '.' : ''}${info.method}` +
            `(${JSON.stringify(info.args)})`,
        );
      };
    } else if (spyOrToggle === false) {
      MessageQueue.prototype.__spy = null;
    } else {
      MessageQueue.prototype.__spy = spyOrToggle;
    }
  }

  callFunctionReturnFlushedQueue = (
    module: string,
    method: string,
    args: Array<any>,
  ) => {
    this.__guard(() => {
      this.__callFunction(module, method, args);
    });

    return this.flushedQueue();
  };

  callFunctionReturnResultAndFlushedQueue = (
    module: string,
    method: string,
    args: Array<any>,
  ) => {
    let result;
    this.__guard(() => {
      result = this.__callFunction(module, method, args);
    });

    return [result, this.flushedQueue()];
  };

  invokeCallbackAndReturnFlushedQueue = (cbID: number, args: Array<any>) => {
    this.__guard(() => {
      this.__invokeCallback(cbID, args);
    });

    return this.flushedQueue();
  };

  flushedQueue = () => {
    this.__guard(() => {
      this.__callImmediates();
    });

    const queue = this._queue;
    this._queue = [[], [], [], this._callID];
    return queue[0].length ? queue : null;
  };

  getEventLoopRunningTime() {
    return new Date().getTime() - this._eventLoopStartTime;
  }

  registerCallableModule(name: string, module: Object) {
    this._lazyCallableModules[name] = () => module;
  }

  registerLazyCallableModule(name: string, factory: void => Object) {
    let module: Object;
    let getValue: ?(void) => Object = factory;
    this._lazyCallableModules[name] = () => {
      if (getValue) {
        module = getValue();
        getValue = null;
      }
      return module;
    };
  }

  getCallableModule(name: string) {
    const getValue = this._lazyCallableModules[name];
    return getValue ? getValue() : null;
  }

  enqueueNativeCall(
    moduleID: number,
    methodID: number,
    params: Array<any>,
    onFail: ?Function,
    onSucc: ?Function,
  ) {
    if (onFail || onSucc) {
      if (__DEV__) {
        this._debugInfo[this._callID] = [moduleID, methodID];
        if (this._callID > DEBUG_INFO_LIMIT) {
          delete this._debugInfo[this._callID - DEBUG_INFO_LIMIT];
        }
      }
      // Encode callIDs into pairs of callback identifiers by shifting left and using the rightmost bit
      // to indicate fail (0) or success (1)
      onFail && params.push(this._callID << 1);
      onSucc && params.push((this._callID << 1) | 1);
      this._successCallbacks[this._callID] = onSucc;
      this._failureCallbacks[this._callID] = onFail;
    }

    if (__DEV__) {
      global.nativeTraceBeginAsyncFlow &&
        global.nativeTraceBeginAsyncFlow(
          TRACE_TAG_REACT_APPS,
          'native',
          this._callID,
        );
    }
    this._callID++;

    this._queue[MODULE_IDS].push(moduleID);
    this._queue[METHOD_IDS].push(methodID);

    if (__DEV__) {
      // Any params sent over the bridge should be encodable as JSON
      JSON.stringify(params);
    }
    this._queue[PARAMS].push(params);

    const now = new Date().getTime();
    if (
      global.nativeFlushQueueImmediate &&
      (now - this._lastFlush >= MIN_TIME_BETWEEN_FLUSHES_MS ||
        this._inCall === 0)
    ) {
      var queue = this._queue;
      this._queue = [[], [], [], this._callID];
      this._lastFlush = now;
      global.nativeFlushQueueImmediate(queue);
    }
    Systrace.counterEvent('pending_js_to_native_queue', this._queue[0].length);

    if (this.__spy) {
      this.__spyNativeCall(moduleID, methodID, params, {
        failCbId: onFail ? params[params.length - 2] : -1,
        successCbId: onSucc ? params[params.length - 1] : -1,
      });
    }
  }

  callSyncHook(moduleID: number, methodID: number, args: Array<any>) {
    if (__DEV__) {
      invariant(
        global.nativeCallSyncHook,
        'Calling synchronous methods on native ' +
          'modules is not supported in Chrome.\n\n Consider providing alternative ' +
          'methods to expose this method in debug mode, e.g. by exposing constants ' +
          'ahead-of-time.',
      );
    }
    const returnValue = global.nativeCallSyncHook(moduleID, methodID, args);
    if (this.__spy) {
      this.__spyNativeCall(moduleID, methodID, args, {
        isSync: true,
        returnValue,
      });
    }
    return returnValue;
  }

  createDebugLookup(moduleID: number, name: string, methods: Array<string>) {
    if (__DEV__) {
      this._remoteModuleTable[moduleID] = name;
      this._remoteMethodTable[moduleID] = methods;
    }
  }

  /**
   * Private methods
   */

  __guard(fn: () => void) {
    this._inCall++;
    try {
      fn();
    } catch (error) {
      ErrorUtils.reportFatalError(error);
    } finally {
      this._inCall--;
    }
  }

  __callImmediates() {
    Systrace.beginEvent('JSTimers.callImmediates()');
    if (!JSTimers) {
      JSTimers = require('JSTimers');
    }
    JSTimers.callImmediates();
    Systrace.endEvent();
  }

  __callFunction(module: string, method: string, args: Array<any>) {
    this._lastFlush = new Date().getTime();
    this._eventLoopStartTime = this._lastFlush;
    Systrace.beginEvent(`${module}.${method}()`);
    if (this.__spy) {
      this.__spyJSCall(module, method, args);
    }
    const moduleMethods = this.getCallableModule(module);
    invariant(
      !!moduleMethods,
      'Module %s is not a registered callable module (calling %s)',
      module,
      method,
    );
    invariant(
      !!moduleMethods[method],
      'Method %s does not exist on module %s',
      method,
      module,
    );
    const result = moduleMethods[method].apply(moduleMethods, args);
    Systrace.endEvent();
    return result;
  }

  __invokeCallback(cbID: number, args: Array<any>) {
    this._lastFlush = new Date().getTime();
    this._eventLoopStartTime = this._lastFlush;

    // The rightmost bit of cbID indicates fail (0) or success (1), the other bits are the callID shifted left.
    const callID = cbID >>> 1;
    const isSuccess = cbID & 1;
    const callback = isSuccess
      ? this._successCallbacks[callID]
      : this._failureCallbacks[callID];

    if (__DEV__) {
      const debug = this._debugInfo[callID];
      const module = debug && this._remoteModuleTable[debug[0]];
      const method = debug && this._remoteMethodTable[debug[0]][debug[1]];
      if (!callback) {
        let errorMessage = `Callback with id ${cbID}: ${module}.${method}() not found`;
        if (method) {
          errorMessage =
            `The callback ${method}() exists in module ${module}, ` +
            'but only one callback may be registered to a function in a native module.';
        }
        invariant(callback, errorMessage);
      }
      const profileName = debug
        ? '<callback for ' + module + '.' + method + '>'
        : cbID + '';
      if (this.__spy) {
        this.__spyJSCall(null, profileName, args, {
          failCbId: isSuccess ? -1 : cbID,
          successCbId: isSuccess ? cbID : -1,
        });
      }
      Systrace.beginEvent(
        `MessageQueue.invokeCallback(${profileName}, ${stringifySafe(args)})`,
      );
    }

    if (!callback) {
      return;
    }

    this._successCallbacks[callID] = this._failureCallbacks[callID] = null;
    callback.apply(null, args);

    if (__DEV__) {
      Systrace.endEvent();
    }
  }

  __spyJSCall(
    module: ?string,
    method: string,
    methodArgs: Array<any>,
    params: any,
  ) {
    if (!this.__spy) {
      return;
    }
    this.__spy({
      type: TO_JS,
      isSync: false,
      module,
      method,
      failCbId: -1,
      successCbId: -1,
      args: methodArgs,
      ...params,
    });
  }

  __spyNativeCall(
    moduleID: number,
    methodID: number,
    methodArgs: Array<any>,
    params: any,
  ) {
    const spy = this.__spy;
    if (!spy) {
      return;
    }

    let moduleName = moduleID + '';
    let methodName = methodID;
    if (__DEV__ && isFinite(moduleID)) {
      moduleName = this._remoteModuleTable[moduleID];
      methodName = this._remoteMethodTable[moduleID][methodID];
    }

    spy({
      type: TO_NATIVE,
      isSync: false,
      module: moduleName,
      method: methodName,
      failCbId: -1,
      successCbId: -1,
      args: methodArgs,
      ...params,
    });
  }
}

module.exports = MessageQueue;
