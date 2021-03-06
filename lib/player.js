/**
 * @license
 * Copyright 2016 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

goog.provide('shaka.Player');

goog.require('goog.asserts');
goog.require('shaka.Deprecate');
goog.require('shaka.log');
goog.require('shaka.media.ActiveStreamMap');
goog.require('shaka.media.AdaptationSetCriteria');
goog.require('shaka.media.BufferingObserver');
goog.require('shaka.media.DrmEngine');
goog.require('shaka.media.ManifestParser');
goog.require('shaka.media.MediaSourceEngine');
goog.require('shaka.media.MuxJSClosedCaptionParser');
goog.require('shaka.media.NoopCaptionParser');
goog.require('shaka.media.PeriodObserver');
goog.require('shaka.media.Playhead');
goog.require('shaka.media.PlayheadObserverManager');
goog.require('shaka.media.PreferenceBasedCriteria');
goog.require('shaka.media.RegionObserver');
goog.require('shaka.media.RegionTimeline');
goog.require('shaka.media.SegmentReference');
goog.require('shaka.media.StreamingEngine');
goog.require('shaka.net.NetworkingEngine');
goog.require('shaka.routing.Walker');
goog.require('shaka.text.SimpleTextDisplayer');
goog.require('shaka.util.ArrayUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.FakeEvent');
goog.require('shaka.util.FakeEventTarget');
goog.require('shaka.util.IDestroyable');
goog.require('shaka.util.ManifestParserUtils');
goog.require('shaka.util.MimeUtils');
goog.require('shaka.util.MultiMap');
goog.require('shaka.util.Periods');
goog.require('shaka.util.PlayerConfiguration');
goog.require('shaka.util.Stats');
goog.require('shaka.util.StreamUtils');


/**
 * Construct a Player.
 *
 * @param {HTMLMediaElement=} mediaElement
 *    When provided, the player will attach to |mediaElement|, similar to
 *    calling |attach|. When not provided, the player will remain detached.
 * @param {function(shaka.Player)=} dependencyInjector Optional callback
 *   which is called to inject mocks into the Player.  Used for testing.
 *
 * @constructor
 * @struct
 * @implements {shaka.util.IDestroyable}
 * @extends {shaka.util.FakeEventTarget}
 * @export
 */
shaka.Player = function(mediaElement, dependencyInjector) {
  shaka.util.FakeEventTarget.call(this);

  /** @private {boolean} */
  this.isAlive_ = true;

  /** @private {HTMLMediaElement} */
  this.video_ = null;

  /**
   * Since we may not always have a text displayer created (e.g. before |load|
   * is called), we need to track what text visibility SHOULD be so that we can
   * ensure that when we create the text displayer. When we create our text
   * displayer, we will use this to show (or not show) text as per the user's
   * requests.
   *
   * @private {boolean}
   */
  this.textVisibility_ = false;

  /** @private {shaka.util.EventManager} */
  this.eventManager_ = new shaka.util.EventManager();

  /** @private {shaka.net.NetworkingEngine} */
  this.networkingEngine_ = null;

  /** @private {shaka.media.DrmEngine} */
  this.drmEngine_ = null;

  /** @private {shaka.media.MediaSourceEngine} */
  this.mediaSourceEngine_ = null;

  /** @private {shaka.media.Playhead} */
  this.playhead_ = null;

  /**
   * The playhead observers are used to monitor the position of the playhead and
   * some other source of data (e.g. buffered content), and raise events.
   *
   * @private {shaka.media.PlayheadObserverManager}
   */
  this.playheadObservers_ = null;

  /** @private {shaka.media.RegionTimeline} */
  this.regionTimeline_ = null;

  /** @private {shaka.media.StreamingEngine} */
  this.streamingEngine_ = null;

  /** @private {shaka.extern.ManifestParser} */
  this.parser_ = null;

  /** @private {?shaka.extern.Manifest} */
  this.manifest_ = null;

  /** @private {?string} */
  this.assetUri_ = null;

  /** @private {shaka.extern.AbrManager} */
  this.abrManager_ = null;

  /**
   * The factory that was used to create the abrManager_ instance.
   * @private {?shaka.extern.AbrManager.Factory}
   */
  this.abrManagerFactory_ = null;

  /**
   * Contains an ID for use with creating streams.  The manifest parser should
   * start with small IDs, so this starts with a large one.
   * @private {number}
   */
  this.nextExternalStreamId_ = 1e9;

  /** @private {!Set.<shaka.extern.Stream>} */
  this.loadingTextStreams_ = new Set();

  /** @private {boolean} */
  this.buffering_ = false;

  /** @private {boolean} */
  this.switchingPeriods_ = true;

  /** @private {?shaka.extern.Variant} */
  this.deferredVariant_ = null;

  /** @private {boolean} */
  this.deferredVariantClearBuffer_ = false;

  /** @private {number} */
  this.deferredVariantClearBufferSafeMargin_ = 0;

  /** @private {?shaka.extern.Stream} */
  this.deferredTextStream_ = null;

  /**
   * A mapping of which streams are/were active in each period. Used when the
   * current period (the one containing playhead) differs from the active
   * period (the one being streamed in by streaming engine).
   *
   * @private {!shaka.media.ActiveStreamMap}
   */
  this.activeStreams_ = new shaka.media.ActiveStreamMap();

  /** @private {?shaka.extern.PlayerConfiguration} */
  this.config_ = this.defaultConfig_();

  /** @private {{width: number, height: number}} */
  this.maxHwRes_ = {width: Infinity, height: Infinity};

  /** @private {shaka.util.Stats} */
  this.stats_ = null;

  /** @private {!shaka.media.AdaptationSetCriteria} */
  this.currentAdaptationSetCriteria_ = new shaka.media.PreferenceBasedCriteria(
      this.config_.preferredAudioLanguage,
      this.config_.preferredVariantRole,
      this.config_.preferredAudioChannelCount);

  /** @private {string} */
  this.currentTextLanguage_ = this.config_.preferredTextLanguage;

  /** @private {string} */
  this.currentTextRole_ = this.config_.preferredTextRole;

  if (dependencyInjector) {
    dependencyInjector(this);
  }

  this.networkingEngine_ = this.createNetworkingEngine();

  // If the browser comes back online after being offline, then try to play
  // again.
  this.eventManager_.listen(window, 'online', () => {
    this.retryStreaming();
  });

  /** @private {shaka.routing.Node} */
  this.detachNode_ = {name: 'detach'};
  /** @private {shaka.routing.Node} */
  this.attachNode_ = {name: 'attach'};
  /** @private {shaka.routing.Node} */
  this.unloadNode_ = {name: 'unload'};
  /** @private {shaka.routing.Node} */
  this.parserNode_ = {name: 'manifest-parser'};
  /** @private {shaka.routing.Node} */
  this.manifestNode_ = {name: 'manifest'};
  /** @private {shaka.routing.Node} */
  this.mediaSourceNode_ = {name: 'media-source'};
  /** @private {shaka.routing.Node} */
  this.drmNode_ = {name: 'drm-engine'};
  /** @private {shaka.routing.Node} */
  this.loadNode_ = {name: 'load'};

  const AbortableOperation = shaka.util.AbortableOperation;

  const actions = new Map();
  actions.set(this.attachNode_, (has, wants) => {
    return AbortableOperation.notAbortable(this.onAttach_(has, wants));
  });
  actions.set(this.detachNode_, (has, wants) => {
    return AbortableOperation.notAbortable(this.onDetach_(has, wants));
  });
  actions.set(this.unloadNode_, (has, wants) => {
    return AbortableOperation.notAbortable(this.onUnload_(has, wants));
  });
  actions.set(this.mediaSourceNode_, (has, wants) => {
    const p = this.onInitializeMediaSourceEngine_(has, wants);
    return AbortableOperation.notAbortable(p);
  });
  actions.set(this.parserNode_, (has, wants) => {
    const p = this.onInitializeParser_(has, wants);
    return AbortableOperation.notAbortable(p);
  });
  actions.set(this.manifestNode_, (has, wants) => {
    // This action is actually abortable, so unlike the other callbacks, this
    // one will return an abortable operation.
    return this.onParseManifest_(has, wants);
  });
  actions.set(this.drmNode_, (has, wants) => {
    const p = this.onInitializeDrm_(has, wants);
    return AbortableOperation.notAbortable(p);
  });
  actions.set(this.loadNode_, (has, wants) => {
    return AbortableOperation.notAbortable(this.onLoad_(has, wants));
  });

  /** @private {shaka.routing.Walker.Implementation} */
  const walkerImplementation = {
    getNext: (at, has, goingTo, wants) => {
      return this.getNextStep_(at, has, goingTo, wants);
    },
    enterNode: (node, has, wants) => {
      this.dispatchEvent(new shaka.util.FakeEvent(
          /* name= */ 'onstatechange',
          /* data= */ {'state': node.name}));

      const action = actions.get(node);
      return action(has, wants);
    },
    handleError: async (has, error) => {
      shaka.log.warning('The walker saw an error:');
      if (error instanceof shaka.util.Error) {
        shaka.log.warning('Error Code:', error.code);
      } else {
        shaka.log.warning('Error Message:', error.message);
        shaka.log.warning('Error Stack:', error.stack);
      }

      // TODO(vaage): We don't always need to return to detached. If we have a
      //              video element we may want to return to attached. We should
      //              have this so that we return to |attachNode| when
      //              |has.mediaElement != null|. We will need to have proper
      //              testing before we make that change.

      // If there is an error, reset us back to the detached state so that
      // we will have a clean slate to restart from.
      await this.onUnload_(has, this.createEmptyPayload_());
      await this.onDetach_(has, this.createEmptyPayload_());

      return this.detachNode_;
    },
  };

  /** @private {shaka.routing.Walker} */
  this.walker_ = new shaka.routing.Walker(
      this.detachNode_,
      this.createEmptyPayload_(),
      walkerImplementation);

  // Even though |attach| will start in later interpreter cycles, it should be
  // the LAST thing we do in the constructor because conceptually it relies on
  // player having been initialized.
  if (mediaElement) {
    this.attach(mediaElement, /* initializeMediaSource= */ true);
  }
};

goog.inherits(shaka.Player, shaka.util.FakeEventTarget);


/**
 * After destruction, a Player object cannot be used again.
 *
 * @override
 * @export
 */
shaka.Player.prototype.destroy = async function() {
  // Make sure we only execute the destroy logic once.
  if (!this.isAlive_) {
    return;
  }

  // Mark as "dead". This should stop external-facing calls from changing our
  // internal state any more. This will stop calls to |attach|, |detach|, etc.
  // from interrupting our final move to the detached state.
  this.isAlive_ = false;

  // Because we have set |isAlive_| to false, we can't call |detach|, so we
  // must talk to the walker directly.
  const events = this.walker_.startNewRoute((currentPayload) => {
    return {
      node: this.detachNode_,
      payload: this.createEmptyPayload_(),
      interruptible: false,
    };
  });

  // Wait until the detach has finished so that we don't interrupt it by
  // calling |destroy| on |this.walker_|. To avoid failing here, we always
  // resolve the promise.
  await new Promise((resolve) => {
    events.onStart = () => {
      shaka.log.info('Preparing to destroy walker...');
    };
    events.onEnd = () => {
      resolve();
    };
    events.onCancel = () => {
      goog.asserts.assert(false,
                          'Our final detach call should never be cancelled.');
      resolve();
    };
    events.onError = () => {
      goog.asserts.assert(false,
                          'Our final detach call should never see an error');
      resolve();
    };
    events.onSkip = () => {
      goog.asserts.assert(false,
                          'Our final detach call should never be skipped');
      resolve();
    };
  });
  await this.walker_.destroy();

  // Tear-down the event manager to ensure messages stop moving around.
  if (this.eventManager_) {
    this.eventManager_.release();
    this.eventManager_ = null;
  }

  this.abrManagerFactory_ = null;
  this.abrManager_ = null;
  this.config_ = null;
  this.textVisibility_ = false;

  if (this.networkingEngine_) {
    await this.networkingEngine_.destroy();
    this.networkingEngine_ = null;
  }
};


/**
 * @define {string} A version number taken from git at compile time.
 * @export
 */
shaka.Player.version = 'v2.5.0-beta3-uncompiled';

// Initialize the deprecation system using the version string we just set
// on the player.
shaka.Deprecate.init(shaka.Player.version);

/**
 * @event shaka.Player.ErrorEvent
 * @description Fired when a playback error occurs.
 * @property {string} type
 *   'error'
 * @property {!shaka.util.Error} detail
 *   An object which contains details on the error.  The error's 'category' and
 *   'code' properties will identify the specific error that occurred.  In an
 *   uncompiled build, you can also use the 'message' and 'stack' properties
 *   to debug.
 * @exportDoc
 */

/**
 * @event shaka.Player.StateChangeEvent
 * @description Fired when the player changes load states.
 * @property {string} type
 *    'onstatechange'
 * @property {string} state
 *    The name of the state that the player just entered.
 * @exportDoc
 */

/**
 * @event shaka.Player.EmsgEvent
 * @description Fired when a non-typical emsg is found in a segment.
 * @property {string} type
 *   'emsg'
 * @property {shaka.extern.EmsgInfo} detail
 *   An object which contains the content of the emsg box.
 * @exportDoc
 */


/**
 * @event shaka.Player.DrmSessionUpdateEvent
 * @description Fired when the CDM has accepted the license response.
 * @property {string} type
 *   'drmsessionupdate'
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionAddedEvent
 * @description Fired when a media timeline region is added.
 * @property {string} type
 *   'timelineregionadded'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionEnterEvent
 * @description Fired when the playhead enters a timeline region.
 * @property {string} type
 *   'timelineregionenter'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.TimelineRegionExitEvent
 * @description Fired when the playhead exits a timeline region.
 * @property {string} type
 *   'timelineregionexit'
 * @property {shaka.extern.TimelineRegionInfo} detail
 *   An object which contains a description of the region.
 * @exportDoc
 */


/**
 * @event shaka.Player.BufferingEvent
 * @description Fired when the player's buffering state changes.
 * @property {string} type
 *   'buffering'
 * @property {boolean} buffering
 *   True when the Player enters the buffering state.
 *   False when the Player leaves the buffering state.
 * @exportDoc
 */


/**
 * @event shaka.Player.LoadingEvent
 * @description Fired when the player begins loading.
 *   Used by the Cast receiver to determine idle state.
 * @property {string} type
 *   'loading'
 * @exportDoc
 */


/**
 * @event shaka.Player.UnloadingEvent
 * @description Fired when the player unloads or fails to load.
 *   Used by the Cast receiver to determine idle state.
 * @property {string} type
 *   'unloading'
 * @exportDoc
 */


/**
 * @event shaka.Player.TextTrackVisibilityEvent
 * @description Fired when text track visibility changes.
 * @property {string} type
 *   'texttrackvisibility'
 * @exportDoc
 */


/**
 * @event shaka.Player.TracksChangedEvent
 * @description Fired when the list of tracks changes.  For example, this will
 *   happen when changing periods or when track restrictions change.
 * @property {string} type
 *   'trackschanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.AdaptationEvent
 * @description Fired when an automatic adaptation causes the active tracks
 *   to change.  Does not fire when the application calls selectVariantTrack()
 *   selectTextTrack(), selectAudioLanguage() or selectTextLanguage().
 * @property {string} type
 *   'adaptation'
 * @exportDoc
 */


/**
 * @event shaka.Player.VariantChangedEvent
 * @description Fired when a call from the application caused a variant change.
 *  Can be triggered by calls to selectVariantTrack() or selectAudioLanguage().
 *  Does not fire when an automatic adaptation causes a variant change.
 * @property {string} type
 *   'variantchanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.TextChangedEvent
 * @description Fired when a call from the application caused a text stream
 *  change. Can be triggered by calls to selectTextTrack() or
 *  selectTextLanguage().
 * @property {string} type
 *   'textchanged'
 * @exportDoc
 */


/**
 * @event shaka.Player.ExpirationUpdatedEvent
 * @description Fired when there is a change in the expiration times of an
 *   EME session.
 * @property {string} type
 *   'expirationupdated'
 * @exportDoc
 */


/**
 * @event shaka.Player.LargeGapEvent
 * @description Fired when the playhead enters a large gap.  If
 *   |config.streaming.jumpLargeGaps| is set, the default action of this event
 *   is to jump the gap; this can be prevented by calling preventDefault() on
 *   the event object.
 * @property {string} type
 *   'largegap'
 * @property {number} currentTime
 *   The current time of the playhead.
 * @property {number} gapSize
 *   The size of the gap, in seconds.
 * @exportDoc
 */


/**
 * @event shaka.Player.StreamingEvent
 * @description Fired after the manifest has been parsed and track information
 *   is available, but before streams have been chosen and before any segments
 *   have been fetched.  You may use this event to configure the player based on
 *   information found in the manifest.
 * @property {string} type
 *   'streaming'
 * @exportDoc
 */


/**
 * These are the EME key statuses that represent restricted playback.
 * 'usable', 'released', 'output-downscaled', 'status-pending' are statuses
 * of the usable keys.  'expired' status is being handled separately in
 * DrmEngine.
 *
 * @const {!Array.<string>}
 * @private
 */
shaka.Player.restrictedStatuses_ = ['output-restricted', 'internal-error'];


/** @private {!Object.<string, function():*>} */
shaka.Player.supportPlugins_ = {};


/**
 * Registers a plugin callback that will be called with support().  The
 * callback will return the value that will be stored in the return value from
 * support().
 *
 * @param {string} name
 * @param {function():*} callback
 * @export
 */
shaka.Player.registerSupportPlugin = function(name, callback) {
  shaka.Player.supportPlugins_[name] = callback;
};


/**
 * Return whether the browser provides basic support.  If this returns false,
 * Shaka Player cannot be used at all.  In this case, do not construct a Player
 * instance and do not use the library.
 *
 * @return {boolean}
 * @export
 */
shaka.Player.isBrowserSupported = function() {
  // Basic features needed for the library to be usable.
  let basic = !!window.Promise && !!window.Uint8Array &&
              !!Array.prototype.forEach;

  return basic &&
      shaka.media.MediaSourceEngine.isBrowserSupported() &&
      shaka.media.DrmEngine.isBrowserSupported();
};


/**
 * Probes the browser to determine what features are supported.  This makes a
 * number of requests to EME/MSE/etc which may result in user prompts.  This
 * should only be used for diagnostics.
 *
 * NOTE: This may show a request to the user for permission.
 *
 * @see https://bit.ly/2ywccmH
 * @return {!Promise.<shaka.extern.SupportType>}
 * @export
 */
shaka.Player.probeSupport = function() {
  goog.asserts.assert(shaka.Player.isBrowserSupported(),
                      'Must have basic support');
  return shaka.media.DrmEngine.probeSupport().then(function(drm) {
    let manifest = shaka.media.ManifestParser.probeSupport();
    let media = shaka.media.MediaSourceEngine.probeSupport();
    let ret = {
      manifest: manifest,
      media: media,
      drm: drm,
    };

    let plugins = shaka.Player.supportPlugins_;
    for (let name in plugins) {
      ret[name] = plugins[name]();
    }

    return ret;
  });
};


/**
 * Tell the player to use |mediaElement| for all |load| requests until |detach|
 * or |destroy| are called.
 *
 * Calling |attach| with |initializedMediaSource=true| will tell the player to
 * take the initial load step and initialize media source.
 *
 * Calls to |attach| will interrupt any in-progress calls to |load| but cannot
 * interrupt calls to |attach|, |detach|, or |unload|.
 *
 * @param {!HTMLMediaElement} mediaElement
 * @param {boolean=} initializeMediaSource
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.attach = function(mediaElement, initializeMediaSource) {
  // Do not allow the player to be used after |destroy| is called.
  if (!this.isAlive_) {
    return Promise.reject(this.createAbortLoadError_());
  }

  const payload = this.createEmptyPayload_();
  payload.mediaElement = mediaElement;

  let destination = initializeMediaSource ?
                    this.mediaSourceNode_ :
                    this.attachNode_;

  // Because |initializeMediaSource| is optional, it can be |undefined| which
  // will get evaluated to |false|. However, we want to default to |true| when
  // the value is not provided. To play well with closure, and to handle the
  // default value on its own, we will override our destination if the value was
  // not provided.
  if (initializeMediaSource === undefined) {
    destination = this.mediaSourceNode_;
  }

  // Tell the walker to go to "attached", but do not let this request be
  // interrupted. If it could be interrupted, it could allow |onLoad| to be
  // called with no media element.
  const events = this.walker_.startNewRoute((currentPayload) => {
    return {
      node: destination,
      payload: payload,
      interruptible: false,
    };
  });

  // List to the events that can occur with our request.
  events.onStart = () => shaka.log.info('Starting attach...');
  return this.wrapWalkerListenersWithPromise_(events);
};


/**
 * Tell the player to stop using its current media element. If the player is:
 *  - detached, this will do nothing,
 *  - attached, this will release the media element,
 *  - loading, this will abort loading, unload, and release the media element,
 *  - playing content, this will stop playback, unload, and release the media
 *    element.
 *
 * Calls to |detach| will interrupt any in-progress calls to |load| but cannot
 * interrupt calls to |attach|, |detach|, or |unload|.
 *
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.detach = function() {
  // Do not allow the player to be used after |destroy| is called.
  if (!this.isAlive_) {
    return Promise.reject(this.createAbortLoadError_());
  }

  // Tell the walker to go "detached", but do not allow it to be interrupted. If
  // it could be interrupted it means that our media element could fall out
  // of sync.
  const events = this.walker_.startNewRoute((currentPayload) => {
    return {
      node: this.detachNode_,
      payload: this.createEmptyPayload_(),
      interruptible: false,
    };
  });

  events.onStart = () => shaka.log.info('Starting detach...');
  return this.wrapWalkerListenersWithPromise_(events);
};


/**
 * Tell the player to either return to:
 *   - detached (when it does not have a media element),
 *   - attached (when it has a media element and |initializedMediaSource=false|)
 *   - media source initialized (when it has a media element and
 *     |initializedMediaSource=true|)
 *
 * Calls to |unload| will interrupt any in-progress calls to |load| but cannot
 * interrupt calls to |attach|, |detach|, or |unload|.
 *
 * @param {boolean=} initializeMediaSource
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.unload = function(initializeMediaSource) {
  // Do not allow the player to be used after |destroy| is called.
  if (!this.isAlive_) {
    return Promise.reject(this.createAbortLoadError_());
  }

  // Since we are going either to attached or detached (through unloaded), we
  // can't allow it to be interrupted or else we could lose track of what
  // media element we are suppose to use.
  //
  // Using the current payload, we can determine which node we want to go to.
  // If we have a media element, we want to go back to attached. If we have no
  // media element, we want to go back to detached.
  const payload = this.createEmptyPayload_();

  const events = this.walker_.startNewRoute((currentPayload) => {
    // When someone calls |unload| we can either be before attached or detached
    // (there is nothing stopping someone from calling |detach| when we are
    // already detached).
    //
    // If we are attached to the correct element, we can tear down the previous
    // playback components and go to the attached media source node depending
    // on whether or not the caller wants to pre-init media source.
    //
    // If we don't have a media element, we assume that we are already at the
    // detached node - but only the walker knows that. To ensure we are actually
    // there, we tell the walker to go to detach. While this is technically
    // unnecessary, it ensures that we are in the state we want to be in and
    // ready for the next request.
    let destination = null;

    if (currentPayload.mediaElement && initializeMediaSource) {
      destination = this.mediaSourceNode_;
    } else if (currentPayload.mediaElement) {
      destination = this.attachNode_;
    } else {
      destination = this.detachNode_;
    }

    goog.asserts.assert(destination, 'We should have picked a destination.');

    // Copy over the media element because we want to keep using the same
    // element - the other values don't matter.
    payload.mediaElement = currentPayload.mediaElement;

    return {
      node: destination,
      payload: payload,
      interruptible: false,
    };
  });

  events.onStart = () => shaka.log.info('Starting unload...');
  return this.wrapWalkerListenersWithPromise_(events);
};


/**
 * Tell the player to load the content at |assetUri| and start playback at
 * |startTime|. Before calling |load|, a call to |attach| must have succeeded.
 *
 * Calls to |load| will interrupt any in-progress calls to |load| but cannot
 * interrupt calls to |attach|, |detach|, or |unload|.
 *
 * @param {string} assetUri
 * @param {?number=} startTime
 *    When |startTime| is |null| or |undefined|, playback will start at the
 *    default start time (startTime=0 for VOD and startTime=liveEdge for LIVE).
 * @param {string|shaka.extern.ManifestParser.Factory=} mimeType
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.load = function(assetUri, startTime, mimeType) {
  // Do not allow the player to be used after |destroy| is called.
  if (!this.isAlive_) {
    return Promise.reject(this.createAbortLoadError_());
  }

  // Right away we know what the asset uri and start-of-load time are. We will
  // fill-in the rest of the information later.
  const payload = this.createEmptyPayload_();
  payload.uri = assetUri;
  payload.startTimeOfLoad = Date.now() / 1000;

  if (mimeType && typeof mimeType != 'string') {
    shaka.Deprecate.deprecateFeature(
        2, 6,
        'Loading with a manifest parser factory',
        'Please register a manifest parser and for the mime-type.');
    const Factory =
        /** @type {shaka.extern.ManifestParser.Factory} */ (mimeType);
    payload.factory = () => new Factory();
  }

  if (mimeType && typeof mimeType == 'string') {
    payload.mimeType = /** @type {string} */ (mimeType);
  }

  // Because we allow |startTime| to be optional, it means that it will be
  // |undefined| when not provided. This means that we need to re-map
  // |undefined| to |null| while preserving |0| as a meaningful value.
  if (startTime !== undefined) {
    payload.startTime = startTime;
  }

  // Tell the walker to go to "loaded", but allow this request to be
  // interrupted, this will allow other requests to cancel a load and quickly
  // start a new load.
  const events = this.walker_.startNewRoute((currentPayload) => {
    if (currentPayload.mediaElement == null) {
      // Because we return null, this "new route" will not be used.
      return null;
    }

    // Keep using whatever media element we have right now.
    payload.mediaElement = currentPayload.mediaElement;

    return {
      node: this.loadNode_,
      payload: payload,
      interruptible: true,
    };
  });

  // Load's request is a little different, so we can't use our normal
  // listeners-to-promise method. It is the only request where we may skip the
  // request, so we need to set the on skip callback to reject with a specific
  // error.
  events.onStart = () => shaka.log.info('Starting load of ' + assetUri + '...');
  return new Promise((resolve, reject) => {
    events.onSkip = () => reject(new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.PLAYER,
        shaka.util.Error.Code.NO_VIDEO_ELEMENT));

    events.onEnd = () => resolve();
    events.onCancel = () => reject(this.createAbortLoadError_());
    events.onError = (e) => reject(e);
  });
};


/**
 * This should only be called by the load graph when it is time to attach to
 * a media element. The only times this may be called are when we are being
 * asked to re-attach to the current media element, or attach to a new media
 * element while not attached to a media element.
 *
 * This method assumes that it is safe for it to execute, the load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * Attaching to a media element is defined as:
 *  - Registering error listeners to the media element.
 *  - Caching the video element for use outside of the load graph.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.onAttach_ = function(has, wants) {
  // If we don't have a media element yet, it means we are entering
  // "attach" from another node.
  //
  // If we have a media element, it should match |wants.mediaElement|
  // because it means we are going from "attach" to "attach".
  //
  // These constraints should be maintained and guaranteed by the routing
  // logic in |getNextStep_|.
  goog.asserts.assert(
      has.mediaElement == null || has.mediaElement == wants.mediaElement,
      'The routing logic failed. MediaElement requirement failed.');

  if (has.mediaElement == null) {
    has.mediaElement = wants.mediaElement;

    const onError = (error) => this.onVideoError_(error);
    this.eventManager_.listen(has.mediaElement, 'error', onError);
  }

  this.video_ = has.mediaElement;

  return Promise.resolve();
};

/**
 * This should only be called by the load graph when it is time to detach from
 * a media element. The only times this may be called are when we are being
 * asked to detach from the current media element, or detach when we are already
 * detached.
 *
 * This method assumes that it is safe for it to execute, the load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * Detaching from a media element is defined as:
 *  - Removing error listeners from the media element.
 *  - Dropping the cached reference to the video element.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.onDetach_ = function(has, wants) {
  // If we are going from "detached" to "detached" we wouldn't have
  // a media element to detach from.
  if (has.mediaElement) {
    this.eventManager_.unlisten(has.mediaElement, 'error');
    has.mediaElement = null;
  }

  // Clear our cached copy of the media element.
  this.video_ = null;

  return Promise.resolve();
};


/**
 * This should only be called by the load graph when it is time to unload all
 * currently initialized playback components. Unlike the other load actions,
 * this action is built to be more general. We need to do this because we don't
 * know what state the player will be in before unloading (including after an
 * error occurred in the middle of a transition).
 *
 * This method assumes that any component could be |null| and should be safe to
 * call from any point in the load graph.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.onUnload_ = async function(has, wants) {
  this.dispatchEvent(new shaka.util.FakeEvent('unloading'));

  // Remove everything that has to do with loading content from our payload
  // since we are releasing everything that depended on it.
  has.currentTime = null;
  has.factory = null;
  has.mimeType = null;
  has.startTime = null;
  has.uri = null;

  // In most cases we should have a media element. The one exception would
  // be if there was an error and we, by chance, did not have a media element.
  if (has.mediaElement) {
    this.eventManager_.unlisten(has.mediaElement, 'loadeddata');
    this.eventManager_.unlisten(has.mediaElement, 'playing');
    this.eventManager_.unlisten(has.mediaElement, 'pause');
    this.eventManager_.unlisten(has.mediaElement, 'ended');
  }

  // Some observers use some playback components, shutting down the observers
  // first ensures that they don't try to use the playback components
  // mid-destroy.
  if (this.playheadObservers_) {
    this.playheadObservers_.release();
    this.playheadObservers_ = null;
  }

  if (this.playhead_) {
    this.playhead_.release();
    this.playhead_ = null;
  }

  // Stop the parser early. Since it is at the start of the pipeline, it should
  // be start early to avoid is pushing new data downstream.
  if (this.parser_) {
    await this.parser_.stop();
    this.parser_ = null;
  }

  // Abr Manager will tell streaming engine what to do, so we need to stop
  // it before we destroy streaming engine. Unlike with the other components,
  // we do not release the instance, we will reuse it in later loads.
  if (this.abrManager_) {
    await this.abrManager_.stop();
  }

  // Streaming engine will push new data to media source engine, so we need
  // to shut it down before destroy media source engine.
  if (this.streamingEngine_) {
    await this.streamingEngine_.destroy();
    this.streamingEngine_ = null;
  }

  // Media source engine holds onto the media element, and in order to detach
  // the media keys (with drm engine), we need to break the connection between
  // media source engine and the media element.
  if (this.mediaSourceEngine_) {
    await this.mediaSourceEngine_.destroy();
    this.mediaSourceEngine_ = null;
  }

  if (this.drmEngine_) {
    await this.drmEngine_.destroy();
    this.drmEngine_ = null;
  }

  this.switchingPeriods_ = true;
  this.manifest_ = null;
  this.assetUri_ = null;
  this.activeStreams_.clear();
  this.loadingTextStreams_.clear();
  this.stats_ = null;

  // Force an exit from the buffering state.
  this.onBuffering_(false);
};


/**
 * This should only be called by the load graph when it is time to initialize
 * media source engine. The only time this may be called is when we are attached
 * to the same media element as in the request.
 *
 * This method assumes that it is safe for it to execute. The load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 *
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.onInitializeMediaSourceEngine_ = async function(
    has, wants) {
  goog.asserts.assert(
      has.mediaElement,
      'We should have a media element when initializing media source.');
  goog.asserts.assert(
      has.mediaElement == wants.mediaElement,
      '|has| and |wants| should have the same media element when ' +
          'initializing media source.');

  goog.asserts.assert(
      this.mediaSourceEngine_ == null,
      'We should not have a media source engine yet.');

  const closedCaptionsParser =
      shaka.media.MuxJSClosedCaptionParser.isSupported() ?
      new shaka.media.MuxJSClosedCaptionParser() :
      new shaka.media.NoopCaptionParser();

  const TextDisplayerFactory = this.config_.textDisplayFactory;
  const textDisplayer = new TextDisplayerFactory();
  textDisplayer.setTextVisibility(this.textVisibility_);

  const mediaSourceEngine = this.createMediaSourceEngine(
      has.mediaElement, closedCaptionsParser, textDisplayer);

  // Wait for media source engine to finish opening. This promise should
  // NEVER be rejected as per the media source engine implementation.
  await mediaSourceEngine.open();

  // Wait until it is ready to actually store the reference.
  this.mediaSourceEngine_ = mediaSourceEngine;
};


/**
 * Create the parser for the asset located at |wants.uri|. This should only be
 * called as part of the load graph.
 *
 * This method assumes that it is safe for it to execute, the load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.onInitializeParser_ = async function(has, wants) {
  goog.asserts.assert(
      has.mediaElement,
      'We should have a media element when initializing the parser.');
  goog.asserts.assert(
      has.mediaElement == wants.mediaElement,
      '|has| and |wants| should have the same media element when ' +
          'initializing the parser.');

  goog.asserts.assert(
      this.networkingEngine_,
      'Need networking engine when initializing the parser.');
  goog.asserts.assert(
       this.config_,
      'Need player config when initializing the parser.');

  // We are going to "lock-in" the factory, mime type, and uri since they are
  // what we are going to use to create our parser and parse the manifest.
  has.factory = wants.factory;
  has.mimeType = wants.mimeType;
  has.uri = wants.uri;

  goog.asserts.assert(
      has.uri,
      'We should have an asset uri when initializing the parsing.');

  // Store references to things we asserted so that we don't need to reassert
  // them again later.
  const assetUri = has.uri;
  const networkingEngine = this.networkingEngine_;

  // Save the uri so that it can be used outside of the load-graph.
  this.assetUri_ = assetUri;

  // Create the parser that we will use to parse the manifest.
  if (has.factory) {
    this.parser_ = has.factory();
  } else {
    this.parser_ = await shaka.media.ManifestParser.create(
        assetUri,
        networkingEngine,
        this.config_.manifest.retryParameters,
        has.mimeType);
  }

  this.parser_.configure(this.config_.manifest);
};


/**
 * Parse the manifest at |has.uri| using the parser that should have already
 * been created. This should only be called as part of the load graph.
 *
 * This method assumes that it is safe for it to execute, the load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!shaka.util.AbortableOperation}
 * @private
 */
shaka.Player.prototype.onParseManifest_ = function(has, wants) {
  goog.asserts.assert(
      has.factory == wants.factory,
      '|has| and |wants| should have the same factory when parsing.');
  goog.asserts.assert(
      has.mimeType == wants.mimeType,
      '|has| and |wants| should have the same mime type when parsing.');
  goog.asserts.assert(
      has.uri == wants.uri,
      '|has| and |wants| should have the same uri when parsing.');

  goog.asserts.assert(
      has.uri,
      '|has| should have a valid uri when parsing.');
  goog.asserts.assert(
      has.uri == this.assetUri_,
      '|has.uri| should match the cached asset uri.');

  goog.asserts.assert(
      this.networkingEngine_,
      'Need networking engine to parse manifest.');
  goog.asserts.assert(
       this.config_,
      'Need player config to parse manifest.');

  goog.asserts.assert(
      this.parser_,
      '|this.parser_| should have been set in an earlier step.');

  // Store references to things we asserted so that we don't need to reassert
  // them again later.
  const assetUri = has.uri;
  const networkingEngine = this.networkingEngine_;

  // This will be needed by the parser once it starts parsing, so we will
  // initialize it now even through it appears a little out-of-place.
  this.regionTimeline_ = new shaka.media.RegionTimeline();
  this.regionTimeline_.setListeners(/* onRegionAdded */ (region) => {
    this.onRegionEvent_('timelineregionadded', region);
  });

  const playerInterface = {
    networkingEngine: networkingEngine,
    filterNewPeriod: (period) => this.filterNewPeriod_(period),
    filterAllPeriods: (periods) => this.filterAllPeriods_(periods),

    // Called when the parser finds a timeline region. This can be called
    // before we start playback or during playback (live/in-progress manifest).
    onTimelineRegionAdded: (region) => this.regionTimeline_.addRegion(region),

    onEvent: (event) => this.dispatchEvent(event),
    onError: (error) => this.onError_(error),
  };

  return new shaka.util.AbortableOperation(
      /* promise= */ Promise.resolve().then(async () => {
        shaka.log.info('Starting parser step...');

        this.manifest_ = await this.parser_.start(assetUri, playerInterface);

        // We require all manifests to have already one period.
        if (this.manifest_.periods.length == 0) {
          throw new shaka.util.Error(
              shaka.util.Error.Severity.CRITICAL,
              shaka.util.Error.Category.MANIFEST,
              shaka.util.Error.Code.NO_PERIODS);
        }

        // Make sure that all periods are either: audio-only, video-only, or
        // audio-video.
        shaka.Player.filterForAVVariants_(this.manifest_.periods);
      }),
      /* onAbort= */ () => {
        shaka.log.info('Aborting parser step...');
        return this.parser_.stop();
      });
};


/**
 * This should only be called by the load graph when it is time to initialize
 * drmEngine. The only time this may be called is when we are attached a
 * media element and have parsed a manifest.
 *
 * The load-graph is responsible for ensuring all assumptions made by this
 * method are valid before executing it.
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {!Promise}
 */
shaka.Player.prototype.onInitializeDrm_ = async function(has, wants) {
  goog.asserts.assert(
      has.factory == wants.factory,
      'The load graph should have ensured the factories matched.');
  goog.asserts.assert(
      has.mimeType == wants.mimeType,
      'The load graph should have ensured the mime types matched.');
  goog.asserts.assert(
      has.uri == wants.uri,
      'The load graph should have ensured the uris matched');

  goog.asserts.assert(
      this.networkingEngine_,
      '|onInitializedDrm| should never be called after |destroy|');
  goog.asserts.assert(
      this.config_,
      '|onInitializedDrm| should never be called after |destroy|');
  goog.asserts.assert(
      this.manifest_,
      '|this.manifest_| should have been set in an earlier step.');

  this.drmEngine_ = this.createDrmEngine({
    netEngine: this.networkingEngine_,
    onError: (e) => {
      this.onError_(e);
    },
    onKeyStatus: (map) => {
      this.onKeyStatus_(map);
    },
    onExpirationUpdated: (id, expiration) => {
      this.onExpirationUpdated_(id, expiration);
    },
    onEvent: (e) => {
      this.dispatchEvent(e);
    },
  });

  this.drmEngine_.configure(this.config_.drm);

  await this.drmEngine_.initForPlayback(
      shaka.util.Periods.getAllVariantsFrom(this.manifest_.periods),
      this.manifest_.offlineSessionIds);

  // Now that we have drm information, filter the manifest (again) so that we
  // can ensure we only use variants with the selected key system.
  this.filterAllPeriods_(this.manifest_.periods);
};

/**
 * This should only be called by the load graph when it is time to load all
 * playback components needed for playback. The only times this may be called
 * is when we are attached to the same media element as in the request.
 *
 * This method assumes that it is safe for it to execute, the load-graph is
 * responsible for ensuring all assumptions are true.
 *
 * Loading is defined as:
 *  - Attaching all playback-related listeners to the media element
 *  - Initializing playback and observers
 *  - Initializing ABR Manager
 *  - Initializing Streaming Engine
 *  - Starting playback at |wants.startTime|
 *
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @private
 */
shaka.Player.prototype.onLoad_ = async function(has, wants) {
  goog.asserts.assert(
      has.factory == wants.factory,
      '|has| and |wants| should have the same factory when loading.');
  goog.asserts.assert(
      has.mimeType == wants.mimeType,
      '|has| and |wants| should have the same mime type when loading.');
  goog.asserts.assert(
      has.uri == wants.uri,
      '|has| and |wants| should have the same uri when loading.');

  goog.asserts.assert(
      has.mediaElement,
      'We should have a media element when loading.');
  goog.asserts.assert(
      wants.startTimeOfLoad,
      '|wants| should tell us when the load was originally requested');

  // Since we are about to start playback, we will lock in the start time as
  // something we are now depending on.
  has.startTime = wants.startTime;

  // Store a reference to values in |has| after asserting so that closure will
  // know that they will still be non-null between calls to await.
  const mediaElement = has.mediaElement;
  const assetUri = has.uri;

  // Save the uri so that it can be used outside of the load-graph.
  this.assetUri_ = assetUri;

  this.dispatchEvent(new shaka.util.FakeEvent('loading'));

  // Stats are for a single playback/load session.
  this.stats_ = new shaka.util.Stats(mediaElement, wants.startTimeOfLoad);

  const updateStateHistory = () => this.updateStateHistory_();
  this.eventManager_.listen(mediaElement, 'playing', updateStateHistory);
  this.eventManager_.listen(mediaElement, 'pause', updateStateHistory);
  this.eventManager_.listen(mediaElement, 'ended', updateStateHistory);

  const AbrManagerFactory = this.config_.abrFactory;
  if (!this.abrManager_ || this.abrManagerFactory_ != AbrManagerFactory) {
    this.abrManagerFactory_ = AbrManagerFactory;
    this.abrManager_ = new AbrManagerFactory();
    this.abrManager_.configure(this.config_.abr);
  }

  // TODO: When a manifest update adds a new period, that period's closed
  // captions should also be turned into text streams. This should be called
  // for each new period as well.
  this.createTextStreamsForClosedCaptions_(this.manifest_.periods);

  // Copy preferred languages from the config again, in case the config was
  // changed between construction and playback.
  this.currentAdaptationSetCriteria_ =
      new shaka.media.PreferenceBasedCriteria(
          this.config_.preferredAudioLanguage,
          this.config_.preferredVariantRole,
          this.config_.preferredAudioChannelCount);

  this.currentTextLanguage_ = this.config_.preferredTextLanguage;

  shaka.Player.applyPlayRange_(this.manifest_.presentationTimeline,
                               this.config_.playRangeStart,
                               this.config_.playRangeEnd);

  await this.drmEngine_.attach(mediaElement);

  this.abrManager_.init((variant, clearBuffer, safeMargin) => {
    return this.switch_(variant, clearBuffer, safeMargin);
  });

  this.playhead_ = this.createPlayhead(has.startTime);
  this.playheadObservers_ = this.createPlayheadObservers_();

  this.streamingEngine_ = this.createStreamingEngine();
  this.streamingEngine_.configure(this.config_.streaming);

  // If the content is multi-codec and the browser can play more than one of
  // them, choose codecs now before we initialize streaming.
  this.chooseCodecsAndFilterManifest_();

  this.dispatchEvent(new shaka.util.FakeEvent('streaming'));

  await this.streamingEngine_.init();

  if (this.config_.streaming.startAtSegmentBoundary) {
    let time = this.adjustStartTime_(this.playhead_.getTime());
    this.playhead_.setStartTime(time);
  }

  // Re-filter the manifest after streams have been chosen.
  this.manifest_.periods.forEach(this.filterNewPeriod_.bind(this));
  // Dispatch a 'trackschanged' event now that all initial filtering is done.
  this.onTracksChanged_();
  // Since the first streams just became active, send an adaptation event.
  this.onAdaptation_();

  // Now that we've filtered out variants that aren't compatible with the
  // active one, update abr manager with filtered variants for the current
  // period.
  const currentPeriod = this.getPresentationPeriod_();
  const hasPrimary = currentPeriod.variants.some((v) => v.primary);

  if (!this.config_.preferredAudioLanguage && !hasPrimary) {
    shaka.log.warning('No preferred audio language set.  We will choose an ' +
                      'arbitrary language initially');
  }

  this.chooseVariant_(currentPeriod.variants);

  // Wait for the 'loadeddata' event to measure load() latency.
  this.eventManager_.listenOnce(mediaElement, 'loadeddata', () => {
    this.stats_.markEndOfLoad();
  });
};


/**
 * Take a series of periods and ensure that they only contain one type of
 * variant. The different options are:
 *  1. Audio-Video
 *  2. Audio-Only
 *  3. Video-Only
 *
 * A manifest can only contain a single type because once we initialize media
 * source to expect specific streams, it must always have content for those
 * streams. If we were to start period 1 with audio+video but period 2 only had
 * audio, media source would block waiting for video content.
 *
 * @param {!Array.<shaka.extern.Period>} periods
 * @private
 */
shaka.Player.filterForAVVariants_ = function(periods) {
  const isAVVariant = (variant) => {
    // Audio-video variants may include both streams separately or may be single
    // multiplexed streams with multiple codecs.
    return (variant.video && variant.audio) ||
           (variant.video && variant.video.codecs.includes(','));
  };
  const hasAVVariant = periods.some((period) => {
    return period.variants.some(isAVVariant);
  });
  if (hasAVVariant) {
    shaka.log.debug('Found variant with audio and video content, ' +
        'so filtering out audio-only content in all periods.');
    periods.forEach((period) => {
      period.variants = period.variants.filter(isAVVariant);
    });
  }
};


/**
 * In case of multiple usable codecs, choose one based on lowest average
 * bandwidth and filter out the rest.
 * @private
 */
shaka.Player.prototype.chooseCodecsAndFilterManifest_ = function() {
  // Collect a list of variants for all periods.
  /** @type {!Array.<shaka.extern.Variant>} */
  let variants = this.manifest_.periods.reduce(
      (variants, period) => variants.concat(period.variants), []);

  // To start, consider a subset of variants based on audio channel preferences.
  // For some content (#1013), surround-sound variants will use a different
  // codec than stereo variants, so it is important to choose codecs **after**
  // considering the audio channel config.
  variants = shaka.util.StreamUtils.filterVariantsByAudioChannelCount(
      variants, this.config_.preferredAudioChannelCount);

  function variantCodecs(variant) {
    // Only consider the base of the codec string.  For example, these should
    // both be considered the same codec: avc1.42c01e, avc1.4d401f
    let baseVideoCodec = '';
    if (variant.video) {
      baseVideoCodec = shaka.util.MimeUtils.getCodecBase(variant.video.codecs);
    }

    let baseAudioCodec = '';
    if (variant.audio) {
      baseAudioCodec = shaka.util.MimeUtils.getCodecBase(variant.audio.codecs);
    }

    return baseVideoCodec + '-' + baseAudioCodec;
  }

  // Now organize variants into buckets by codecs.
  /** @type {!shaka.util.MultiMap.<shaka.extern.Variant>} */
  const variantsByCodecs = new shaka.util.MultiMap();
  variants.forEach((variant) => {
    const group = variantCodecs(variant);
    variantsByCodecs.push(group, variant);
  });

  // Compute the average bandwidth for each group of variants.
  // Choose the lowest-bandwidth codecs.
  let bestCodecs = null;
  let lowestAverageBandwidth = Infinity;
  variantsByCodecs.forEach((codecs, variants) => {
    let sum = 0;
    let num = 0;
    variants.forEach(function(variant) {
      sum += variant.bandwidth || 0;
      ++num;
    });
    let averageBandwidth = sum / num;
    shaka.log.debug('codecs', codecs, 'avg bandwidth', averageBandwidth);

    if (averageBandwidth < lowestAverageBandwidth) {
      bestCodecs = codecs;
      lowestAverageBandwidth = averageBandwidth;
    }
  });
  goog.asserts.assert(bestCodecs != null, 'Should have chosen codecs!');
  goog.asserts.assert(!isNaN(lowestAverageBandwidth),
      'Bandwidth should be a number!');

  // Filter out any variants that don't match, forcing AbrManager to choose from
  // the most efficient variants possible.
  this.manifest_.periods.forEach(function(period) {
    period.variants = period.variants.filter(function(variant) {
      let codecs = variantCodecs(variant);
      if (codecs == bestCodecs) return true;

      shaka.log.debug('Dropping Variant (better codec available)', variant);
      return false;
    });
  });
};


/**
 * Create a new DrmEngine instance. This may be replaced by tests to create fake
 * instances. Configuration and initialization will be handled after
 * |createDrmEngine|.
 *
 * @param {shaka.media.DrmEngine.PlayerInterface} playerInterface
 * @return {!shaka.media.DrmEngine}
 */
shaka.Player.prototype.createDrmEngine = function(playerInterface) {
  return new shaka.media.DrmEngine(playerInterface);
};


/**
 * Creates a new instance of NetworkingEngine.  This can be replaced by tests
 * to create fake instances instead.
 *
 * @return {!shaka.net.NetworkingEngine}
 */
shaka.Player.prototype.createNetworkingEngine = function() {
  /** @type {function(number, number)} */
  const onProgressUpdated_ = (deltaTimeMs, numBytes) => {
    // In some situations, such as during offline storage, the abr manager might
    // not yet exist. Therefore, we need to check if abr manager has been
    // initialized before using it.
    if (this.abrManager_) {
      this.abrManager_.segmentDownloaded(deltaTimeMs, numBytes);
    }
  };

  return new shaka.net.NetworkingEngine(onProgressUpdated_);
};


/**
 * Creates a new instance of Playhead.  This can be replaced by tests to create
 * fake instances instead.
 *
 * @param {?number} startTime
 * @return {!shaka.media.Playhead}
 */
shaka.Player.prototype.createPlayhead = function(startTime) {
  goog.asserts.assert(this.manifest_, 'Must have manifest');
  goog.asserts.assert(this.video_, 'Must have video');
  return new shaka.media.Playhead(
      this.video_,
      this.manifest_.presentationTimeline,
      this.manifest_.minBufferTime || 0,
      this.config_.streaming,
      startTime,
      this.onSeek_.bind(this),
      (event) => this.dispatchEvent(event));
};


/**
 * Create observers for the new playback session. The observers are responsible
 * for notifying the app and player of specific events.
 *
 * @return {!shaka.media.PlayheadObserverManager}
 * @private
 */
shaka.Player.prototype.createPlayheadObservers_ = function() {
  goog.asserts.assert(this.manifest_, 'Must have manifest');
  goog.asserts.assert(this.regionTimeline_, 'Must have region timeline');
  goog.asserts.assert(this.video_, 'Must have video element');

  // Create the period observer. This will allow us to notify the app when we
  // transition between periods.
  const periodObserver = new shaka.media.PeriodObserver(this.manifest_);
  periodObserver.setListeners((period) => this.onChangePeriod_());

  // Create the region observer. This will allow us to notify the app when we
  // move in and out of timeline regions.
  const regionObserver = new shaka.media.RegionObserver(this.regionTimeline_);
  const onEnterRegion = (region, seeking) => {
    this.onRegionEvent_('timelineregionenter', region);
  };
  const onExitRegion = (region, seeking) => {
    this.onRegionEvent_('timelineregionexit', region);
  };
  const onSkipRegion = (region, seeking) => {
    // If we are seeking, we don't want to surface the enter/exit events since
    // they didn't play through them.
    if (!seeking) {
      this.onRegionEvent_('timelineregionenter', region);
      this.onRegionEvent_('timelineregionexit', region);
    }
  };
  regionObserver.setListeners(onEnterRegion, onExitRegion, onSkipRegion);

  // Create the buffering observer. This will allow us to notify the player when
  // we are falling behind and something needs to be done before we run out of
  // buffering.

  // This is how much we need to buffer after we enter a starving state before
  // we can become satisfied again.
  const rebufferingThreshold = Math.max(
      this.manifest_.minBufferTime,
      this.config_.streaming.rebufferingGoal);
  const bufferingObserver = new shaka.media.BufferingObserver(
      /* starvingThreshold= */ rebufferingThreshold,
      /* startAs= */ shaka.media.BufferingObserver.State.STARVING,
      /* getSecondsBufferedAfter= */ (timeInSeconds) => {
        return shaka.media.TimeRangesUtils.bufferedAheadOf(
            this.video_.buffered, timeInSeconds);
      },
      /* isBufferedToEnd= */ () => {
        return this.isBufferedToEnd_();
      });
  const onBufferStarving = () => this.onBuffering_(/* isBuffering= */ true);
  const onBufferSatisfied = () => this.onBuffering_(/* isBuffering= */ false);
  bufferingObserver.setListeners(onBufferStarving, onBufferSatisfied);

  // Now that we have all our observers, create a manager for them.
  const manager = new shaka.media.PlayheadObserverManager(this.video_);
  manager.manage(periodObserver);
  manager.manage(regionObserver);
  manager.manage(bufferingObserver);

  return manager;
};


/**
 * Create a new media source engine. This will ONLY be replaced by tests as a
 * way to inject fake media source engine instances.
 *
 * @param {!HTMLMediaElement} mediaElement
 * @param {!shaka.media.IClosedCaptionParser} closedCaptionsParser
 * @param {!shaka.extern.TextDisplayer} textDisplayer
 *
 * @return {!shaka.media.MediaSourceEngine}
 */
shaka.Player.prototype.createMediaSourceEngine = function(
    mediaElement, closedCaptionsParser, textDisplayer) {
  return new shaka.media.MediaSourceEngine(
      mediaElement, closedCaptionsParser, textDisplayer);
};


/**
 * Creates a new instance of StreamingEngine.  This can be replaced by tests
 * to create fake instances instead.
 *
 * @return {!shaka.media.StreamingEngine}
 */
shaka.Player.prototype.createStreamingEngine = function() {
  goog.asserts.assert(
      this.playhead_ && this.mediaSourceEngine_ && this.manifest_,
      'Must not be destroyed');

  /** @type {shaka.media.StreamingEngine.PlayerInterface} */
  let playerInterface = {
    getPresentationTime: () => this.playhead_.getTime(),
    mediaSourceEngine: this.mediaSourceEngine_,
    netEngine: this.networkingEngine_,
    onChooseStreams: this.onChooseStreams_.bind(this),
    onCanSwitch: this.canSwitch_.bind(this),
    onError: this.onError_.bind(this),
    onEvent: (event) => this.dispatchEvent(event),
    onManifestUpdate: this.onManifestUpdate_.bind(this),
    onSegmentAppended: this.onSegmentAppended_.bind(this),
  };

  return new shaka.media.StreamingEngine(this.manifest_, playerInterface);
};


/**
 * Configure the Player instance.
 *
 * The config object passed in need not be complete.  It will be merged with
 * the existing Player configuration.
 *
 * Config keys and types will be checked.  If any problems with the config
 * object are found, errors will be reported through logs and this returns
 * false.  If there are errors, valid config objects are still set.
 *
 * @param {string|!Object} config This should either be a field name or an
 *   object following the form of {@link shaka.extern.PlayerConfiguration},
 *   where you may omit any field you do not wish to change.
 * @param {*=} value This should be provided if the previous parameter
 *   was a string field name.
 * @return {boolean} True if the passed config object was valid, false if there
 *   were invalid entries.
 * @export
 */
shaka.Player.prototype.configure = function(config, value) {
  goog.asserts.assert(this.config_, 'Config must not be null!');
  goog.asserts.assert(typeof(config) == 'object' || arguments.length == 2,
                      'String configs should have values!');

  // ('fieldName', value) format
  if (arguments.length == 2 && typeof(config) == 'string') {
    config = this.convertToConfigObject_(config, value);
  }

  goog.asserts.assert(typeof(config) == 'object', 'Should be an object!');

  let ret = shaka.util.PlayerConfiguration.mergeConfigObjects(
      this.config_, config, this.defaultConfig_());

  this.applyConfig_();
  return ret;
};


/**
 * Convert config from ('fieldName', value) format to a partial
 * shaka.extern.PlayerConfiguration object.
 * E. g. from ('manifest.retryParameters.maxAttempts', 1) to
 * { manifest: { retryParameters: { maxAttempts: 1 }}}.
 *
 * @param {string} fieldName
 * @param {*} value
 * @return {!Object}
 * @private
 */
shaka.Player.prototype.convertToConfigObject_ = function(fieldName, value) {
  let configObject = {};
  let last = configObject;
  let searchIndex = 0;
  let nameStart = 0;
  while (true) {  // eslint-disable-line no-constant-condition
    let idx = fieldName.indexOf('.', searchIndex);
    if (idx < 0) {
      break;
    }
    if (idx == 0 || fieldName[idx - 1] != '\\') {
      let part = fieldName.substring(nameStart, idx).replace(/\\\./g, '.');
      last[part] = {};
      last = last[part];
      nameStart = idx + 1;
    }
    searchIndex = idx + 1;
  }

  last[fieldName.substring(nameStart).replace(/\\\./g, '.')] = value;
  return configObject;
};


/**
 * Apply config changes.
 * @private
 */
shaka.Player.prototype.applyConfig_ = function() {
  if (this.parser_) {
    this.parser_.configure(this.config_.manifest);
  }
  if (this.drmEngine_) {
    this.drmEngine_.configure(this.config_.drm);
  }
  if (this.streamingEngine_) {
    this.streamingEngine_.configure(this.config_.streaming);

    // Need to apply the restrictions to every period.
    try {
      // this.filterNewPeriod_() may throw.
      this.manifest_.periods.forEach(this.filterNewPeriod_.bind(this));
    } catch (error) {
      this.onError_(error);
    }

    // If the stream we are playing is restricted, we need to switch.
    let activeAudio = this.streamingEngine_.getBufferingAudio();
    let activeVideo = this.streamingEngine_.getBufferingVideo();
    let period = this.getPresentationPeriod_();
    let activeVariant = shaka.util.StreamUtils.getVariantByStreams(
        activeAudio, activeVideo, period.variants);
    if (this.abrManager_ && activeVariant &&
        activeVariant.allowedByApplication &&
        activeVariant.allowedByKeySystem) {
      // Update AbrManager variants to match these new settings.
      this.chooseVariant_(period.variants);
    } else {
      shaka.log.debug('Choosing new streams after changing configuration');
      this.chooseStreamsAndSwitch_(period);
    }
  }

  if (this.abrManager_) {
    this.abrManager_.configure(this.config_.abr);
    // Simply enable/disable ABR with each call, since multiple calls to these
    // methods have no effect.
    if (this.config_.abr.enabled && !this.switchingPeriods_) {
      this.abrManager_.enable();
    } else {
      this.abrManager_.disable();
    }
  }
};


/**
 * Return a copy of the current configuration.  Modifications of the returned
 * value will not affect the Player's active configuration.  You must call
 * player.configure() to make changes.
 *
 * @return {shaka.extern.PlayerConfiguration}
 * @export
 */
shaka.Player.prototype.getConfiguration = function() {
  goog.asserts.assert(this.config_, 'Config must not be null!');

  let ret = this.defaultConfig_();
  shaka.util.PlayerConfiguration.mergeConfigObjects(
      ret, this.config_, this.defaultConfig_());
  return ret;
};


/**
 * Return a reference to the current configuration. Modifications to the
 * returned value will affect the Player's active configuration. This method
 * is not exported as sharing configuration with external objects is not
 * supported.
 *
 * @return {shaka.extern.PlayerConfiguration}
 */
shaka.Player.prototype.getSharedConfiguration = function() {
  goog.asserts.assert(
      this.config_, 'Cannot call getSharedConfiguration after call destroy!');
  return this.config_;
};


/**
 * Reset configuration to default.
 * @export
 */
shaka.Player.prototype.resetConfiguration = function() {
  goog.asserts.assert(this.config_, 'Cannot be destroyed');
  // Remove the old keys so we remove open-ended dictionaries like drm.servers
  // but keeps the same object reference.
  for (const key in this.config_) {
    delete this.config_[key];
  }

  shaka.util.PlayerConfiguration.mergeConfigObjects(
      this.config_, this.defaultConfig_(), this.defaultConfig_());
  this.applyConfig_();
};


/**
 * @return {HTMLMediaElement} A reference to the HTML Media Element passed
 *     to the constructor or to attach().
 * @export
 */
shaka.Player.prototype.getMediaElement = function() {
  return this.video_;
};


/**
 * @return {shaka.net.NetworkingEngine} A reference to the Player's networking
 *     engine.  Applications may use this to make requests through Shaka's
 *     networking plugins.
 * @export
 */
shaka.Player.prototype.getNetworkingEngine = function() {
  return this.networkingEngine_;
};


/**
 * @return {?string} If an asset is loaded, returns the asset URI given in
 *   the last call to load().  Otherwise, returns null.
 * @export
 */
shaka.Player.prototype.getAssetUri = function() {
  return this.assetUri_;
};


/**
 * @return {?string} If a manifest is loaded, returns the manifest URI given in
 *   the last call to load().  Otherwise, returns null.
 * @export
 */
shaka.Player.prototype.getManifestUri = function() {
  shaka.Deprecate.deprecateFeature(
    2, 6, 'getManifestUri', 'Please use "getAssetUri" instead.');

  return this.assetUri_;
};


/**
 * @return {boolean} True if the current stream is live.  False otherwise.
 * @export
 */
shaka.Player.prototype.isLive = function() {
  return this.manifest_ ?
         this.manifest_.presentationTimeline.isLive() :
         false;
};


/**
 * @return {boolean} True if the current stream is in-progress VOD.
 *   False otherwise.
 * @export
 */
shaka.Player.prototype.isInProgress = function() {
  return this.manifest_ ?
         this.manifest_.presentationTimeline.isInProgress() :
         false;
};


/**
 * @return {boolean} True for audio-only content.  False otherwise.
 * @export
 */
shaka.Player.prototype.isAudioOnly = function() {
  if (!this.manifest_ || !this.manifest_.periods.length) {
    return false;
  }

  let variants = this.manifest_.periods[0].variants;
  if (!variants.length) {
    return false;
  }

  // Note that if there are some audio-only variants and some audio-video
  // variants, the audio-only variants are removed during filtering.
  // Therefore if the first variant has no video, that's sufficient to say it
  // is audio-only content.
  return !variants[0].video;
};


/**
 * Get the seekable range for the current stream.
 * @return {{start: number, end: number}}
 * @export
 */
shaka.Player.prototype.seekRange = function() {
  let start = 0;
  let end = 0;
  if (this.manifest_) {
    let timeline = this.manifest_.presentationTimeline;
    start = timeline.getSeekRangeStart();
    end = timeline.getSeekRangeEnd();
  }
  return {'start': start, 'end': end};
};


/**
 * Get the key system currently being used by EME.  This returns the empty
 * string if not using EME.
 *
 * @return {string}
 * @export
 */
shaka.Player.prototype.keySystem = function() {
  return this.drmEngine_ ? this.drmEngine_.keySystem() : '';
};


/**
 * Get the DrmInfo used to initialize EME.  This returns null when not using
 * EME.
 *
 * @return {?shaka.extern.DrmInfo}
 * @export
 */
shaka.Player.prototype.drmInfo = function() {
  return this.drmEngine_ ? this.drmEngine_.getDrmInfo() : null;
};


/**
 * The next known expiration time for any EME session.  If the sessions never
 * expire, or there are no EME sessions, this returns Infinity.
 *
 * @return {number}
 * @export
 */
shaka.Player.prototype.getExpiration = function() {
  return this.drmEngine_ ? this.drmEngine_.getExpiration() : Infinity;
};


/**
 * @return {boolean} True if the Player is in a buffering state.
 * @export
 */
shaka.Player.prototype.isBuffering = function() {
  return this.buffering_;
};


/**
 * Gets the current effective playback rate.  If using trick play, it will
 * return the current trick play rate; otherwise, it will return the video
 * playback rate.
 * @return {number}
 * @export
 */
shaka.Player.prototype.getPlaybackRate = function() {
  return this.playhead_ ? this.playhead_.getPlaybackRate() : 0;
};


/**
 * Skip through the content without playing.  Simulated using repeated seeks.
 *
 * Trick play will be canceled automatically if the playhead hits the beginning
 * or end of the seekable range for the content.
 *
 * @param {number} rate The playback rate to simulate.  For example, a rate of
 *     2.5 would result in 2.5 seconds of content being skipped every second.
 *     To trick-play backward, use a negative rate.
 * @export
 */
shaka.Player.prototype.trickPlay = function(rate) {
  shaka.log.debug('Trick play rate', rate);
  if (this.playhead_) {
    this.playhead_.setPlaybackRate(rate);
  }

  if (this.streamingEngine_) {
    this.streamingEngine_.setTrickPlay(rate != 1);
  }
};


/**
 * Cancel trick-play.
 * @export
 */
shaka.Player.prototype.cancelTrickPlay = function() {
  shaka.log.debug('Trick play canceled');
  if (this.playhead_) {
    this.playhead_.setPlaybackRate(1);
  }

  if (this.streamingEngine_) {
    this.streamingEngine_.setTrickPlay(false);
  }
};


/**
 * Return a list of variant tracks available for the current
 * Period.  If there are multiple Periods, then you must seek to the Period
 * before being able to switch.
 *
 * @return {!Array.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.getVariantTracks = function() {
  const currentVariant = this.getPresentationVariant_();

  const tracks = [];

  // Convert each variant to a track.
  for (const variant of this.getSelectableVariants_()) {
    const track = shaka.util.StreamUtils.variantToTrack(variant);
    track.active = variant == currentVariant;

    tracks.push(track);
  }

  return tracks;
};


/**
 * Return a list of text tracks available for the current
 * Period.  If there are multiple Periods, then you must seek to the Period
 * before being able to switch.
 *
 * @return {!Array.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.getTextTracks = function() {
  const currentText = this.getPresentationText_();

  const tracks = [];

  // Convert all selectable text streams to tracks.
  for (const text of this.getSelectableText_()) {
    const track = shaka.util.StreamUtils.textStreamToTrack(text);
    track.active = text == currentText;

    tracks.push(track);
  }

  return tracks;
};


/**
 * Select a specific text track.  Note that AdaptationEvents are not
 * fired for manual track selections.
 *
 * @param {shaka.extern.Track} track
 * @export
 */
shaka.Player.prototype.selectTextTrack = function(track) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  const stream = period.textStreams.find((stream) => stream.id == track.id);

  if (!stream) {
    shaka.log.error('No stream with id', track.id);
    return;
  }

  // Add entries to the history.
  this.addTextStreamToSwitchHistory_(
      period, stream, /* fromAdaptation= */ false);

  this.switchTextStream_(stream);

  // Workaround for https://github.com/google/shaka-player/issues/1299
  // When track is selected, back-propogate the language to
  // currentTextLanguage_.
  this.currentTextLanguage_ = stream.language;
};


/**
 * Find the CEA 608/708 text stream embedded in video, and switch to it.
 * @export
 */
shaka.Player.prototype.selectEmbeddedTextTrack = function() {
  shaka.Deprecate.deprecateFeature(
      2, 6,
      'selectEmbeddedTextTrack',
      [
        'If closed captions are signaled in the manifest, a text stream will',
        'be created to represent them. Please use SelectTextTrack.',
      ].join(' '));

  const tracks = this.getTextTracks().filter((track) => {
    return track.mimeType == shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE;
  });
  if (tracks.length > 0) {
    this.selectTextTrack(tracks[0]);
  } else {
    shaka.log.warning('Unable to find the text track embedded in the video.');
  }
};


/**
 * @return {boolean} True if we are using any embedded text tracks present.
 * @export
 */
shaka.Player.prototype.usingEmbeddedTextTrack = function() {
  shaka.Deprecate.deprecateFeature(
      2, 6,
      'usingEmbeddedTextTrack',
      [
        'If closed captions are signaled in the manifest, a text stream will',
        'be created to represent them. There should be no reason to know if',
        'the player is playing embedded text.',
      ].join(' '));

  const activeText =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingText() : null;
  return activeText != null &&
      activeText.mimeType == shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE;
};


/**
 * Select a specific track.  Note that AdaptationEvents are not fired for manual
 * track selections.
 *
 * @param {shaka.extern.Track} track
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin Optional amount of buffer (in seconds) to retain
 *   when clearing the buffer. Useful for switching variant quickly without
 *   causing a buffering event.
 *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
 *   Can cause hiccups on some browsers if chosen too small, e.g. The amount of
 *   two segments is a fair minimum to consider as safeMargin value.
 * @export
 */
shaka.Player.prototype.selectVariantTrack = function(
    track, clearBuffer, safeMargin = 0) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  if (this.config_.abr.enabled) {
    shaka.log.alwaysWarn('Changing tracks while abr manager is enabled will ' +
                         'likely result in the selected track being ' +
                         'overriden. Consider disabling abr before calling ' +
                         'selectVariantTrack().');
  }

  const variant = period.variants.find((variant) => variant.id == track.id);
  if (!variant) {
    shaka.log.error('No variant with id', track.id);
    return;
  }

  // Double check that the track is allowed to be played. The track list should
  // only contain playable variants, but if restrictions change and
  // |selectVariantTrack| is called before the track list is updated, we could
  // get a now-restricted variant.
  if (!shaka.util.StreamUtils.isPlayable(variant)) {
    shaka.log.error('Unable to switch to restricted track', track.id);
    return;
  }

  // Add entries to the history.
  this.addVariantToSwitchHistory_(period, variant, /* fromAdaptation */ false);
  this.switchVariant_(variant, clearBuffer, safeMargin);

  // Workaround for https://github.com/google/shaka-player/issues/1299
  // When track is selected, back-propogate the language to
  // currentAudioLanguage_.
  this.currentAdaptationSetCriteria_ = new shaka.media.ExampleBasedCriteria(
      variant);

  // Update AbrManager variants to match these new settings.
  this.chooseVariant_(period.variants);
};


/**
 * Return a list of audio language-role combinations available for the current
 * Period.
 *
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @export
 */
shaka.Player.prototype.getAudioLanguagesAndRoles = function() {
  // TODO: This assumes that language is always on the audio stream. This is not
  //       true when audio and video are muxed together.
  // TODO: If the language is on the video stream, how do roles affect the
  //       the language-role pairing?

  /** @type {!Array.<?shaka.extern.Stream>} */
  const audioStreams = [];
  for (const variant of this.getSelectableVariants_()) {
    audioStreams.push(variant.audio);
  }

  return shaka.Player.getLanguageAndRolesFrom_(audioStreams);
};


/**
 * Return a list of text language-role combinations available for the current
 * Period.
 *
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @export
 */
shaka.Player.prototype.getTextLanguagesAndRoles = function() {
  return shaka.Player.getLanguageAndRolesFrom_(this.getSelectableText_());
};


/**
 * Return a list of audio languages available for the current Period.
 *
 * @return {!Array.<string>}
 * @export
 */
shaka.Player.prototype.getAudioLanguages = function() {
  // TODO: This assumes that language is always on the audio stream. This is not
  //       true when audio and video are muxed together.

  /** @type {!Array.<?shaka.extern.Stream>} */
  const audioStreams = [];
  for (const variant of this.getSelectableVariants_()) {
    audioStreams.push(variant.audio);
  }

  return Array.from(shaka.Player.getLanguagesFrom_(audioStreams));
};


/**
 * Return a list of text languages available for the current Period.
 *
 * @return {!Array.<string>}
 * @export
 */
shaka.Player.prototype.getTextLanguages = function() {
  return Array.from(shaka.Player.getLanguagesFrom_(this.getSelectableText_()));
};


/**
 * Sets currentAudioLanguage and currentVariantRole to the selected
 * language and role, and chooses a new variant if need be.
 *
 * @param {string} language
 * @param {string=} role
 * @export
 */
shaka.Player.prototype.selectAudioLanguage = function(language, role) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  this.currentAdaptationSetCriteria_ = new shaka.media.PreferenceBasedCriteria(
      language, role || '', 0);

  // TODO: Refactor to only change audio and not affect text.
  this.chooseStreamsAndSwitch_(period);
};


/**
 * Sets currentTextLanguage and currentTextRole to the selected
 * language and role, and chooses a new text stream if need be.
 *
 * @param {string} language
 * @param {string=} role
 * @export
 */
shaka.Player.prototype.selectTextLanguage = function(language, role) {
  const period = this.getPresentationPeriod_();

  // No period means we are not playing anything. If we are not playing
  // anything, we can't select anything.
  if (period == null) {
    return;
  }

  this.currentTextLanguage_ = language;
  this.currentTextRole_ = role || '';
  // TODO: Refactor to only change text and not affect audio.
  this.chooseStreamsAndSwitch_(period);
};


/**
 * @return {boolean} True if the current text track is visible.
 * @export
 */
shaka.Player.prototype.isTextTrackVisible = function() {
  // We always cache what the app wants so that even if we don't have anything
  // loaded, we know what will happen when we load content. Since we cache it,
  // we can always return the cached value, but assert that we are in sync.
  if (this.mediaSourceEngine_) {
    const displayer = this.mediaSourceEngine_.getTextDisplayer();
    goog.asserts.assert(
        this.textVisibility_ == displayer.isTextVisible(),
        'text visibility cache and actual are out of sync.');
  }

  return this.textVisibility_;
};


/**
 * Set the visibility of the current text track, if any.
 *
 * @param {boolean} on
 * @return {!Promise}
 * @export
 */
shaka.Player.prototype.setTextTrackVisibility = async function(on) {
  if (on == this.textVisibility_) {
    return;
  }

  if (this.mediaSourceEngine_) {
    this.mediaSourceEngine_.getTextDisplayer().setTextVisibility(on);
  }

  this.textVisibility_ = on;
  this.onTextTrackVisibility_();

  // If we always stream text, don't do anything special to StreamingEngine.
  if (this.config_.streaming.alwaysStreamText) {
    return;
  }

  // Load text stream when the user chooses to show the caption, and pause
  // loading text stream when the user chooses to hide the caption.
  if (!this.streamingEngine_) {
    return;
  }

  const StreamUtils = shaka.util.StreamUtils;

  if (on) {
    let period = this.getPresentationPeriod_();
    let textStreams = StreamUtils.filterStreamsByLanguageAndRole(
        period.textStreams,
        this.currentTextLanguage_,
        this.currentTextRole_);
    let stream = textStreams[0];
    if (stream) {
      await this.streamingEngine_.loadNewTextStream(stream);
    }
  } else {
    this.streamingEngine_.unloadTextStream();
  }
};


/**
 * Returns current playhead time as a Date.
 *
 * @return {Date}
 * @export
 */
shaka.Player.prototype.getPlayheadTimeAsDate = function() {
  if (!this.manifest_) return null;

  goog.asserts.assert(this.isLive(),
      'getPlayheadTimeAsDate should be called on a live stream!');

  let time =
      this.manifest_.presentationTimeline.getPresentationStartTime() * 1000 +
      this.video_.currentTime * 1000;

  return new Date(time);
};


/**
 * Returns the presentation start time as a Date.
 *
 * @return {Date}
 * @export
 */
shaka.Player.prototype.getPresentationStartTimeAsDate = function() {
  if (!this.manifest_) return null;

  goog.asserts.assert(this.isLive(),
      'getPresentationStartTimeAsDate should be called on a live stream!');

  let time =
      this.manifest_.presentationTimeline.getPresentationStartTime() * 1000;

  return new Date(time);
};


/**
 * Return the information about the current buffered ranges.
 *
 * @return {shaka.extern.BufferedInfo}
 * @export
 */
shaka.Player.prototype.getBufferedInfo = function() {
  if (!this.mediaSourceEngine_) {
    return {
      total: [],
      audio: [],
      video: [],
      text: [],
    };
  }

  return this.mediaSourceEngine_.getBufferedInfo();
};


/**
 * Return playback and adaptation stats.
 *
 * @return {shaka.extern.Stats}
 * @export
 */
shaka.Player.prototype.getStats = function() {
  // If we have no stats object it means that we have not loaded any content, so
  // return an empty stats blob.
  if (this.stats_ == null) {
    return shaka.util.Stats.getEmptyBlob();
  }

  this.stats_.updateTime(this.buffering_);
  this.updateStateHistory_();

  goog.asserts.assert(this.video_, 'If we have stats, we should have video_');
  const element = /** @type {!HTMLVideoElement} */ (this.video_);

  if (element.getVideoPlaybackQuality) {
    const info = element.getVideoPlaybackQuality();

    this.stats_.setDroppedFrames(
        Number(info.droppedVideoFrames),
        Number(info.totalVideoFrames));
  }

  const variant = this.getPresentationVariant_();

  if (variant) {
    this.stats_.setVariantBandwidth(variant.bandwidth);
  }

  if (variant && variant.video) {
    this.stats_.setResolution(
        /* width= */ variant.video.width || NaN,
        /* height= */ variant.video.height || NaN);
  }

  if (this.abrManager_) {
    const estimate = this.abrManager_.getBandwidthEstimate();
    this.stats_.setBandwidthEstimate(estimate);
  }

  return this.stats_.getBlob();
};


/**
 * Adds the given text track to the current Period.  load() must resolve before
 * calling.  The current Period or the presentation must have a duration.  This
 * returns a Promise that will resolve with the track that was created, when
 * that track can be switched to.
 *
 * @param {string} uri
 * @param {string} language
 * @param {string} kind
 * @param {string} mime
 * @param {string=} codec
 * @param {string=} label
 * @return {!Promise.<shaka.extern.Track>}
 * @export
 */
shaka.Player.prototype.addTextTrack = function(
    uri, language, kind, mime, codec, label) {
  /** @type {?shaka.extern.Period} */
  const period = this.getPresentationPeriod_();

  // We need to be playing something before we add text tracks. If we don't have
  // a period, it means we are not playing anything.
  if (period == null) {
    shaka.log.error(
        'Must call load() and wait for it to resolve before adding text ' +
        'tracks.');
    return Promise.reject();
  }

  const ContentType = shaka.util.ManifestParserUtils.ContentType;

  // Get the Period duration.
  /** @type {number} */
  const periodIndex = this.manifest_.periods.indexOf(period);
  /** @type {number} */
  const nextPeriodIndex = periodIndex + 1;
  /** @type {number} */
  const nextPeriodStart = nextPeriodIndex >= this.manifest_.periods.length ?
                          this.manifest_.presentationTimeline.getDuration() :
                          this.manifest_.periods[nextPeriodIndex].startTime;
  /** @type {number} */
  const periodDuration = nextPeriodStart - period.startTime;
  if (periodDuration == Infinity) {
    return Promise.reject(new shaka.util.Error(
        shaka.util.Error.Severity.RECOVERABLE,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.CANNOT_ADD_EXTERNAL_TEXT_TO_LIVE_STREAM));
  }

  /** @type {shaka.extern.Stream} */
  let stream = {
    id: this.nextExternalStreamId_++,
    originalId: null,
    createSegmentIndex: Promise.resolve.bind(Promise),
    findSegmentPosition: function(time) { return 1; },
    getSegmentReference: function(ref) {
      if (ref != 1) return null;
      return new shaka.media.SegmentReference(
          1, 0, periodDuration, function() { return [uri]; }, 0, null);
    },
    initSegmentReference: null,
    presentationTimeOffset: 0,
    mimeType: mime,
    codecs: codec || '',
    kind: kind,
    encrypted: false,
    keyId: null,
    language: language,
    label: label || null,
    type: ContentType.TEXT,
    primary: false,
    trickModeVideo: null,
    emsgSchemeIdUris: null,
    roles: [],
    channelsCount: null,
    closedCaptions: null,
  };

  // Add the stream to the loading list to ensure it isn't switched to while it
  // is initializing.
  this.loadingTextStreams_.add(stream);
  period.textStreams.push(stream);

  return this.streamingEngine_.loadNewTextStream(stream)
          .then(function() {
    goog.asserts.assert(period, 'The period should still be non-null here.');

    const activeText = this.streamingEngine_.getBufferingText();
    if (activeText) {
      // If this was the first text stream, StreamingEngine will start streaming
      // it in loadNewTextStream.  To reflect this, update the active stream.
      this.activeStreams_.useText(period, activeText);
    }
    // Remove the stream from the loading list.
    this.loadingTextStreams_.delete(stream);

    shaka.log.debug('Choosing new streams after adding a text stream');
    this.chooseStreamsAndSwitch_(period);
    this.onTracksChanged_();

    return {
      id: stream.id,
      active: false,
      type: ContentType.TEXT,
      bandwidth: 0,
      language: language,
      label: label || null,
      kind: kind,
      width: null,
      height: null,
    };
  }.bind(this));
};


/**
 * Set the maximum resolution that the platform's hardware can handle.
 * This will be called automatically by shaka.cast.CastReceiver to enforce
 * limitations of the Chromecast hardware.
 *
 * @param {number} width
 * @param {number} height
 * @export
 */
shaka.Player.prototype.setMaxHardwareResolution = function(width, height) {
  this.maxHwRes_.width = width;
  this.maxHwRes_.height = height;
};


/**
 * Retry streaming after a failure.  Does nothing if not in a failure state.
 * @return {boolean} False if unable to retry.
 * @export
 */
shaka.Player.prototype.retryStreaming = function() {
  return this.streamingEngine_ ? this.streamingEngine_.retry() : false;
};


/**
 * Return the manifest information if it's loaded. Otherwise, return null.
 * @return {?shaka.extern.Manifest}
 * @export
 */
shaka.Player.prototype.getManifest = function() {
  return this.manifest_;
};


/**
 * @param {shaka.extern.Period} period
 * @param {shaka.extern.Variant} variant
 * @param {boolean} fromAdaptation
 * @private
 */
shaka.Player.prototype.addVariantToSwitchHistory_ = function(
    period, variant, fromAdaptation) {
  this.activeStreams_.useVariant(period, variant);
  this.stats_.getSwitchHistory().updateCurrentVariant(variant, fromAdaptation);
};


/**
 * @param {shaka.extern.Period} period
 * @param {shaka.extern.Stream} textStream
 * @param {boolean} fromAdaptation
 * @private
 */
shaka.Player.prototype.addTextStreamToSwitchHistory_ = function(
    period, textStream, fromAdaptation) {
  this.activeStreams_.useText(period, textStream);
  this.stats_.getSwitchHistory().updateCurrentText(textStream, fromAdaptation);
};


/**
 * @return {shaka.extern.PlayerConfiguration}
 * @private
 */
shaka.Player.prototype.defaultConfig_ = function() {
  const config = shaka.util.PlayerConfiguration.createDefault();

  config.streaming.failureCallback = (error) => {
    this.defaultStreamingFailureCallback_(error);
  };

  // Because this.video_ may not be set when the config is built, the default
  // TextDisplay factory must capture a reference to "this" as "self" to use at
  // the time we call the factory.  Bind can't be used here because we call the
  // factory with "new", effectively removing any binding to "this".
  const self = this;
  config.textDisplayFactory = function() {
    return new shaka.text.SimpleTextDisplayer(self.video_);
  };

  return config;
};


/**
 * @param {!shaka.util.Error} error
 * @private
 */
shaka.Player.prototype.defaultStreamingFailureCallback_ = function(error) {
  let retryErrorCodes = [
    shaka.util.Error.Code.BAD_HTTP_STATUS,
    shaka.util.Error.Code.HTTP_ERROR,
    shaka.util.Error.Code.TIMEOUT,
  ];

  if (this.isLive() && retryErrorCodes.includes(error.code)) {
    error.severity = shaka.util.Error.Severity.RECOVERABLE;

    shaka.log.warning('Live streaming error.  Retrying automatically...');
    this.retryStreaming();
  }
};


/**
 * For CEA closed captions embedded in the video streams, create dummy text
 * stream.
 * @param {!Array.<!shaka.extern.Period>} periods
 * @private
 */
shaka.Player.prototype.createTextStreamsForClosedCaptions_ = function(periods) {
  const ContentType = shaka.util.ManifestParserUtils.ContentType;

  for (let periodIndex = 0; periodIndex < periods.length; periodIndex++) {
    const period = periods[periodIndex];
    // A map of the closed captions id and the new dummy text stream.
    let closedCaptionsMap = new Map();
    for (let variant of period.variants) {
      if (variant.video && variant.video.closedCaptions) {
        let video = variant.video;
        for (const id of video.closedCaptions.keys()) {
          if (!closedCaptionsMap.has(id)) {
            let textStream = {
              id: this.nextExternalStreamId_++,  // A globally unique ID.
              originalId: id, // The CC ID string, like 'CC1', 'CC3', etc.
              createSegmentIndex: Promise.resolve.bind(Promise),
              findSegmentPosition: (time) => { return null; },
              getSegmentReference: (ref) => { return null; },
              initSegmentReference: null,
              presentationTimeOffset: 0,
              mimeType: shaka.util.MimeUtils.CLOSED_CAPTION_MIMETYPE,
              codecs: '',
              kind:
                  shaka.util.ManifestParserUtils.TextStreamKind.CLOSED_CAPTION,
              encrypted: false,
              keyId: null,
              language: video.closedCaptions.get(id),
              label: null,
              type: ContentType.TEXT,
              primary: false,
              trickModeVideo: null,
              emsgSchemeIdUris: null,
              roles: video.roles,
              channelsCount: null,
              closedCaptions: null,
            };
            closedCaptionsMap.set(id, textStream);
          }
        }
      }
    }
    for (const textStream of closedCaptionsMap.values()) {
      period.textStreams.push(textStream);
    }
  }
};


/**
 * Filters a list of periods.
 * @param {!Array.<!shaka.extern.Period>} periods
 * @private
 */
shaka.Player.prototype.filterAllPeriods_ = function(periods) {
  goog.asserts.assert(this.video_, 'Must not be destroyed');
  const ArrayUtils = shaka.util.ArrayUtils;
  const StreamUtils = shaka.util.StreamUtils;

  /** @type {?shaka.extern.Stream} */
  let activeAudio =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingAudio() : null;
  /** @type {?shaka.extern.Stream} */
  let activeVideo =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingVideo() : null;

  let filterPeriod = StreamUtils.filterNewPeriod.bind(
      null, this.drmEngine_, activeAudio, activeVideo);
  periods.forEach(filterPeriod);

  let validPeriodsCount = ArrayUtils.count(periods, function(period) {
    return period.variants.some(StreamUtils.isPlayable);
  });

  // If none of the periods are playable, throw CONTENT_UNSUPPORTED_BY_BROWSER.
  if (validPeriodsCount == 0) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.CONTENT_UNSUPPORTED_BY_BROWSER);
  }

  // If only some of the periods are playable, throw UNPLAYABLE_PERIOD.
  if (validPeriodsCount < periods.length) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.UNPLAYABLE_PERIOD);
  }

  periods.forEach(function(period) {
    let tracksChanged = shaka.util.StreamUtils.applyRestrictions(
        period.variants, this.config_.restrictions, this.maxHwRes_);
    if (tracksChanged && this.streamingEngine_ &&
        this.getPresentationPeriod_() == period) {
      this.onTracksChanged_();
    }

    this.checkRestrictedVariants_(period.variants);
  }.bind(this));
};


/**
 * Filters a new period.
 * @param {shaka.extern.Period} period
 * @private
 */
shaka.Player.prototype.filterNewPeriod_ = function(period) {
  goog.asserts.assert(this.video_, 'Must not be destroyed');
  const StreamUtils = shaka.util.StreamUtils;

  /** @type {?shaka.extern.Stream} */
  let activeAudio =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingAudio() : null;
  /** @type {?shaka.extern.Stream} */
  let activeVideo =
      this.streamingEngine_ ? this.streamingEngine_.getBufferingVideo() : null;

  StreamUtils.filterNewPeriod(
      this.drmEngine_, activeAudio, activeVideo, period);

  /** @type {!Array.<shaka.extern.Variant>} */
  let variants = period.variants;

  // Check for playable variants before restrictions, so that we can give a
  // special error when there were tracks but they were all filtered.
  const hasPlayableVariant = variants.some(StreamUtils.isPlayable);
  if (!hasPlayableVariant) {
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.UNPLAYABLE_PERIOD);
  }

  this.checkRestrictedVariants_(period.variants);

  const tracksChanged = shaka.util.StreamUtils.applyRestrictions(
      variants, this.config_.restrictions, this.maxHwRes_);

  // Trigger the track change event if the restrictions now prevent use from
  // using a variant that we previously thought we could use.
  if (tracksChanged && this.streamingEngine_ &&
      this.getPresentationPeriod_() == period) {
    this.onTracksChanged_();
  }

  // For new Periods, we may need to create new sessions for any new init data.
  const curDrmInfo = this.drmEngine_ ? this.drmEngine_.getDrmInfo() : null;
  if (curDrmInfo) {
    for (const variant of variants) {
      for (const drmInfo of variant.drmInfos) {
        // Ignore any data for different key systems.
        if (drmInfo.keySystem == curDrmInfo.keySystem) {
          for (const initData of (drmInfo.initData || [])) {
            this.drmEngine_.newInitData(
                initData.initDataType, initData.initData);
          }
        }
      }
    }
  }
};


/**
 * Switches to the given variant, deferring if needed.
 * @param {shaka.extern.Variant} variant
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin
 * @private
 */
shaka.Player.prototype.switchVariant_ =
    function(variant, clearBuffer = false, safeMargin = 0) {
  if (this.switchingPeriods_) {
    // Store this action for later.
    this.deferredVariant_ = variant;
    this.deferredVariantClearBuffer_ = clearBuffer;
    this.deferredVariantClearBufferSafeMargin_ = safeMargin;
  } else {
    // Act now.
    this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin);
    // Dispatch a 'variantchanged' event
    this.onVariantChanged_();
  }
};


/**
 * Switches to the given text stream, deferring if needed.
 * @param {shaka.extern.Stream} textStream
 * @private
 */
shaka.Player.prototype.switchTextStream_ = function(textStream) {
  if (this.switchingPeriods_) {
    // Store this action for later.
    this.deferredTextStream_ = textStream;
  } else {
    // Act now.
    this.streamingEngine_.switchTextStream(textStream);
    this.onTextChanged_();
  }
};


/**
 * Verifies that the active streams according to the player match those in
 * StreamingEngine.
 * @private
 */
shaka.Player.prototype.assertCorrectActiveStreams_ = function() {
  if (!this.streamingEngine_ || !this.manifest_ || !goog.DEBUG) return;

  const activePeriod = this.streamingEngine_.getBufferingPeriod();
  const currentPeriod = this.getPresentationPeriod_();
  if (activePeriod == null || activePeriod != currentPeriod) {
    return;
  }

  let activeAudio = this.streamingEngine_.getBufferingAudio();
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  let activeText = this.streamingEngine_.getBufferingText();

  // If we have deferred variants/text we want to compare against those rather
  // than what we are actually streaming.
  const expectedAudio = this.deferredVariant_ ?
                        this.deferredVariant_.audio :
                        activeAudio;

  const expectedVideo = this.deferredVariant_ ?
                        this.deferredVariant_.video :
                        activeVideo;

  const expectedText = this.deferredTextStream_ || activeText;

  const actualVariant = this.activeStreams_.getVariant(currentPeriod);
  const actualText = this.activeStreams_.getText(currentPeriod);

  goog.asserts.assert(
      actualVariant.audio == expectedAudio,
      'Inconsistent active audio stream');
  goog.asserts.assert(
      actualVariant.video == expectedVideo,
      'Inconsistent active video stream');

  // Because we always set a text stream to be active in the active stream map,
  // regardless of whether or not we are actually streaming text, it is possible
  // for these to be out of line.
  goog.asserts.assert(
      expectedText == null || actualText == expectedText,
      'Inconsistent active text stream');
};


/**
 * @param {number} time
 * @return {number}
 * @private
 */
shaka.Player.prototype.adjustStartTime_ = function(time) {
  /** @type {?shaka.extern.Stream} */
  let activeAudio = this.streamingEngine_.getBufferingAudio();
  /** @type {?shaka.extern.Stream} */
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  /** @type {?shaka.extern.Period} */
  let period = this.getPresentationPeriod_();

  // This method is called after StreamingEngine.init resolves, which means that
  // all the active streams have had createSegmentIndex called.
  function getAdjustedTime(stream, time) {
    if (!stream) return null;
    let idx = stream.findSegmentPosition(time - period.startTime);
    if (idx == null) return null;
    let ref = stream.getSegmentReference(idx);
    if (!ref) return null;
    let refTime = ref.startTime + period.startTime;
    goog.asserts.assert(refTime <= time, 'Segment should start before time');
    return refTime;
  }

  let audioStartTime = getAdjustedTime(activeAudio, time);
  let videoStartTime = getAdjustedTime(activeVideo, time);

  // If we have both video and audio times, pick the larger one.  If we picked
  // the smaller one, that one will download an entire segment to buffer the
  // difference.
  if (videoStartTime != null && audioStartTime != null) {
    return Math.max(videoStartTime, audioStartTime);
  } else if (videoStartTime != null) {
    return videoStartTime;
  } else if (audioStartTime != null) {
    return audioStartTime;
  } else {
    return time;
  }
};


/**
 * Callback from PlayheadObserver.
 *
 * @param {boolean} buffering
 * @private
 */
shaka.Player.prototype.onBuffering_ = function(buffering) {
  // Before setting |buffering_|, update the time spent in the previous state.
  // We must check |stats_| first because we call |onBuffering_| after
  // unloading.
  if (this.stats_) {
    this.stats_.updateTime(this.buffering_);
  }

  this.buffering_ = buffering;
  this.updateStateHistory_();

  if (this.playhead_) {
    this.playhead_.setBuffering(buffering);
  }

  let event = new shaka.util.FakeEvent('buffering', {'buffering': buffering});
  this.dispatchEvent(event);
};


/**
 * Callback from PlayheadObserver.
 * @private
 */
shaka.Player.prototype.onChangePeriod_ = function() {
  this.onTracksChanged_();
};


/**
 * Called from potential initiators of state changes, or before returning stats
 * to the user.
 *
 * This method decides if state has actually changed, updates the last entry,
 * and adds a new one if needed.
 *
 * @private
 */
shaka.Player.prototype.updateStateHistory_ = function() {
  if (this.stats_) {
    this.stats_.getStateHistory().update(this.buffering_);
  }
};


/**
 * Callback from Playhead.
 *
 * @private
 */
shaka.Player.prototype.onSeek_ = function() {
  if (this.playheadObservers_) {
    this.playheadObservers_.notifyOfSeek();
  }
  if (this.streamingEngine_) {
    this.streamingEngine_.seeked();
  }
};


/**
 * Chooses a variant from all possible variants while taking into account
 * restrictions, preferences, and ABR.
 *
 * On error, this dispatches an error event and returns null.
 *
 * @param {!Array.<shaka.extern.Variant>} allVariants
 * @return {?shaka.extern.Variant}
 * @private
 */
shaka.Player.prototype.chooseVariant_ = function(allVariants) {
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  try {
    // |variants| are the filtered variants, use |period.variants| so we know
    // why they we restricted.
    this.checkRestrictedVariants_(allVariants);
  } catch (e) {
    this.onError_(e);
    return null;
  }

  goog.asserts.assert(
      allVariants.length, 'Should have thrown for no Variants.');

  const playableVariants = allVariants.filter((variant) => {
    return shaka.util.StreamUtils.isPlayable(variant);
  });

  // Update the abr manager with newly filtered variants.
  const adaptationSet = this.currentAdaptationSetCriteria_.create(
      playableVariants);
  this.abrManager_.setVariants(Array.from(adaptationSet.values()));
  return this.abrManager_.chooseVariant();
};


/**
 * Choose a text stream from all possible text streams while taking into
 * account user preference.
 *
 * @param {!Array.<shaka.extern.Stream>} textStreams
 * @return {?shaka.extern.Stream}
 * @private
 */
shaka.Player.prototype.chooseTextStream_ = function(textStreams) {
  const subset = shaka.util.StreamUtils.filterStreamsByLanguageAndRole(
      textStreams,
      this.currentTextLanguage_,
      this.currentTextRole_);

  return subset[0] || null;
};


/**
 * Chooses streams from the given Period and switches to them.
 * Called after a config change, a new text stream, a key status event, or an
 * explicit language change.
 *
 * @param {!shaka.extern.Period} period
 * @private
 */
shaka.Player.prototype.chooseStreamsAndSwitch_ = function(period) {
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  // Because we're running this after a config change (manual language change),
  // a new text stream, or a key status event, and because switching to an
  // active stream is a no-op, it is always okay to clear the buffer here.
  const chosenVariant = this.chooseVariant_(period.variants);
  if (chosenVariant) {
    this.addVariantToSwitchHistory_(
        period, chosenVariant, /* fromAdaptation= */ true);
    this.switchVariant_(chosenVariant, /* clearBuffers */ true);
  }

  // Only switch text if we should be streaming text right now.
  const chosenText = this.chooseTextStream_(period.textStreams);
  if (chosenText && this.shouldStreamText_()) {
    this.addTextStreamToSwitchHistory_(
      period, chosenText, /* fromAdaptation= */ true);
    this.switchTextStream_(chosenText);
  }

  // Send an adaptation event so that the UI can show the new language/tracks.
  this.onAdaptation_();
};


/**
 * Callback from StreamingEngine, invoked when a period starts. This method
 * must always "succeed" so it may not throw an error. Any errors must be
 * routed to |onError|.
 *
 * @param {!shaka.extern.Period} period
 * @return {shaka.media.StreamingEngine.ChosenStreams}
 *    An object containing the chosen variant and text stream.
 * @private
 */
shaka.Player.prototype.onChooseStreams_ = function(period) {
  shaka.log.debug('onChooseStreams_', period);

  goog.asserts.assert(this.config_, 'Must not be destroyed');

  try {
    shaka.log.v2('onChooseStreams_, choosing variant from ', period.variants);
    shaka.log.v2('onChooseStreams_, choosing text from ', period.textStreams);

    const chosen = this.chooseStreams_(period);

    shaka.log.v2('onChooseStreams_, chose variant ', chosen.variant);
    shaka.log.v2('onChooseStreams_, chose text ', chosen.text);

    return chosen;
  } catch (e) {
    this.onError_(e);
    return {variant: null, text: null};
  }
};


/**
 * This is the internal logic for |onChooseStreams_|. This separation is done
 * to allow this implementation to throw errors without consequence.
 *
 * @param {shaka.extern.Period} period
 *    The period that we are selecting streams from.
 * @return {shaka.media.StreamingEngine.ChosenStreams}
 *    An object containing the chosen variant and text stream.
 * @private
 */
shaka.Player.prototype.chooseStreams_ = function(period) {
  // We are switching Periods, so the AbrManager will be disabled.  But if we
  // want to abr.enabled, we do not want to call AbrManager.enable before
  // canSwitch_ is called.
  this.switchingPeriods_ = true;
  this.abrManager_.disable();

  shaka.log.debug('Choosing new streams after period changed');

  let chosenVariant = this.chooseVariant_(period.variants);
  let chosenText = this.chooseTextStream_(period.textStreams);

  // Ignore deferred variant or text streams only if we are starting a new
  // period.  In this case, any deferred switches were from an older period, so
  // they do not apply.  We can still have deferred switches from the current
  // period in the case of an early call to select*Track while we are setting up
  // the first period.  This can happen with the 'streaming' event.
  if (this.deferredVariant_) {
    if (period.variants.includes(this.deferredVariant_)) {
      chosenVariant = this.deferredVariant_;
    }
    this.deferredVariant_ = null;
  }

  if (this.deferredTextStream_) {
    if (period.textStreams.includes(this.deferredTextStream_)) {
      chosenText = this.deferredTextStream_;
    }
    this.deferredTextStream_ = null;
  }

  if (chosenVariant) {
    this.addVariantToSwitchHistory_(
        period, chosenVariant, /* fromAdaptation= */ true);
  }

  if (chosenText) {
    this.addTextStreamToSwitchHistory_(
        period, chosenText, /* fromAdaptation= */ true);
  }

  // Check if we should show text (based on difference between audio and text
  // languages). Only check this during startup so we don't "pop-up" captions
  // mid playback.
  const startingUp = !this.streamingEngine_.getBufferingPeriod();
  const chosenAudio = chosenVariant ? chosenVariant.audio : null;
  if (startingUp && chosenAudio && chosenText) {
    if (this.shouldShowText_(chosenAudio, chosenText)) {
      this.setTextTrackVisibility(true);
      this.onTextTrackVisibility_();
    }
  }

  // Don't fire a tracks-changed event since we aren't inside the new Period
  // yet.
  // Don't initialize with a text stream unless we should be streaming text.
  if (this.shouldStreamText_()) {
    return {variant: chosenVariant, text: chosenText};
  } else {
    return {variant: chosenVariant, text: null};
  }
};


/**
 * Check if we should show text on screen automatically.
 *
 * The text should automatically be shown if the text is language-compatible
 * with the user's text language preference, but not compatible with the audio.
 *
 * For example:
 *   preferred | chosen | chosen |
 *   text      | text   | audio  | show
 *   -----------------------------------
 *   en-CA     | en     | jp     | true
 *   en        | en-US  | fr     | true
 *   fr-CA     | en-US  | jp     | false
 *   en-CA     | en-US  | en-US  | false
 *
 * @param {shaka.extern.Stream} audioStream
 * @param {shaka.extern.Stream} textStream
 * @return {boolean}
 * @private
 */
shaka.Player.prototype.shouldShowText_ = function(audioStream, textStream) {
  const areLanguageCompatible = shaka.util.LanguageUtils.areLanguageCompatible;
  const normalize = shaka.util.LanguageUtils.normalize;

  /** @type {string} */
  const preferredTextLocale = normalize(this.config_.preferredTextLanguage);
  /** @type {string} */
  const audioLocale = normalize(audioStream.language);
  /** @type {string} */
  const textLocale = normalize(textStream.language);

  return areLanguageCompatible(textLocale, preferredTextLocale) &&
         !areLanguageCompatible(audioLocale, textLocale);
};


/**
 * Callback from StreamingEngine, invoked when the period is set up.
 *
 * @private
 */
shaka.Player.prototype.canSwitch_ = function() {
  shaka.log.debug('canSwitch_');
  goog.asserts.assert(this.config_, 'Must not be destroyed');

  this.switchingPeriods_ = false;

  if (this.config_.abr.enabled) {
    this.abrManager_.enable();
  }

  // If we still have deferred switches, switch now.
  if (this.deferredVariant_) {
    this.streamingEngine_.switchVariant(
        this.deferredVariant_, this.deferredVariantClearBuffer_,
        this.deferredVariantClearBufferSafeMargin_);
    this.deferredVariant_ = null;
  }
  if (this.deferredTextStream_) {
    this.streamingEngine_.switchTextStream(this.deferredTextStream_);
    this.deferredTextStream_ = null;
  }
};


/**
 * Callback from StreamingEngine.
 *
 * @private
 */
shaka.Player.prototype.onManifestUpdate_ = function() {
  if (this.parser_ && this.parser_.update) {
    this.parser_.update();
  }
};


/**
 * Callback from StreamingEngine.
 *
 * @private
 */
shaka.Player.prototype.onSegmentAppended_ = function() {
  if (this.playhead_) {
    this.playhead_.onSegmentAppended();
  }
};


/**
 * Callback from AbrManager.
 *
 * @param {shaka.extern.Variant} variant
 * @param {boolean=} clearBuffer
 * @param {number=} safeMargin Optional amount of buffer (in seconds) to retain
 *   when clearing the buffer.
 *   Defaults to 0 if not provided. Ignored if clearBuffer is false.
 * @private
 */
shaka.Player.prototype.switch_ = function(
    variant, clearBuffer = false, safeMargin = 0) {
  shaka.log.debug('switch_');
  goog.asserts.assert(this.config_.abr.enabled,
      'AbrManager should not call switch while disabled!');
  goog.asserts.assert(!this.switchingPeriods_,
      'AbrManager should not call switch while transitioning between Periods!');
  goog.asserts.assert(this.manifest_, 'We need a manifest to switch variants.');

  const period = this.findPeriodWithVariant_(variant);
  goog.asserts.assert(period, 'A period should contain the variant.');

  this.addVariantToSwitchHistory_(period, variant, /* fromAdaptation */ true);

  if (!this.streamingEngine_) {
    // There's no way to change it.
    return;
  }

  this.streamingEngine_.switchVariant(variant, clearBuffer, safeMargin);
  this.onAdaptation_();
};


/**
 * Dispatches an 'adaptation' event.
 * @private
 */
shaka.Player.prototype.onAdaptation_ = function() {
  // Delay the 'adaptation' event so that StreamingEngine has time to absorb
  // the changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('adaptation'));
};


/**
 * Dispatches a 'trackschanged' event.
 * @private
 */
shaka.Player.prototype.onTracksChanged_ = function() {
  // Delay the 'trackschanged' event so StreamingEngine has time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('trackschanged'));
};


/**
 * Dispatches a 'variantchanged' event.
 * @private
 */
shaka.Player.prototype.onVariantChanged_ = function() {
  // Delay the 'trackschanged' event so StreamingEngine has time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('variantchanged'));
};


/**
 * Dispatches a 'textchanged' event.
 * @private
 */
shaka.Player.prototype.onTextChanged_ = function() {
  // Delay the 'textchanged' event so StreamingEngine time to absorb the
  // changes before the user tries to query it.
  this.delayDispatchEvent_(new shaka.util.FakeEvent('textchanged'));
};


/** @private */
shaka.Player.prototype.onTextTrackVisibility_ = function() {
  let event = new shaka.util.FakeEvent('texttrackvisibility');
  this.dispatchEvent(event);
};


/**
 * @param {!shaka.util.Error} error
 * @private
 */
shaka.Player.prototype.onError_ = function(error) {
  goog.asserts.assert(error instanceof shaka.util.Error, 'Wrong error type!');

  // Errors dispatched after |destroy| is called are not meaningful and should
  // be safe to ignore.
  if (!this.isAlive_) { return; }

  let event = new shaka.util.FakeEvent('error', {'detail': error});
  this.dispatchEvent(event);
  if (event.defaultPrevented) {
    error.handled = true;
  }
};


/**
 * @param {!Event} event
 * @private
 */
shaka.Player.prototype.onEvent_ = function(event) {
  this.dispatchEvent(event);
};


/**
 * When we fire region events, we need to copy the information out of the region
 * to break the connection with the player's internal data. We do the copy here
 * because this is the transition point between the player and the app.
 *
 * @param {string} eventName
 * @param {shaka.extern.TimelineRegionInfo} region
 *
 * @private
 */
shaka.Player.prototype.onRegionEvent_ = function(eventName, region) {
  // Always make a copy to avoid exposing our internal data to the app.
  const clone = {
    schemeIdUri: region.schemeIdUri,
    value: region.value,
    startTime: region.startTime,
    endTime: region.endTime,
    id: region.id,
    eventElement: region.eventElement,
  };

  this.onEvent_(new shaka.util.FakeEvent(eventName, {detail: clone}));
};


/**
 * @param {!Event} event
 * @private
 */
shaka.Player.prototype.onVideoError_ = function(event) {
  if (!this.video_.error) return;

  let code = this.video_.error.code;
  if (code == 1 /* MEDIA_ERR_ABORTED */) {
    // Ignore this error code, which should only occur when navigating away or
    // deliberately stopping playback of HTTP content.
    return;
  }

  // Extra error information from MS Edge and IE11:
  let extended = this.video_.error.msExtendedCode;
  if (extended) {
    // Convert to unsigned:
    if (extended < 0) {
      extended += Math.pow(2, 32);
    }
    // Format as hex:
    extended = extended.toString(16);
  }

  // Extra error information from Chrome:
  let message = this.video_.error.message;

  this.onError_(new shaka.util.Error(
      shaka.util.Error.Severity.CRITICAL,
      shaka.util.Error.Category.MEDIA,
      shaka.util.Error.Code.VIDEO_ERROR,
      code, extended, message));
};


/**
 * @param {!Object.<string, string>} keyStatusMap A map of hex key IDs to
 *   statuses.
 * @private
 */
shaka.Player.prototype.onKeyStatus_ = function(keyStatusMap) {
  goog.asserts.assert(this.streamingEngine_, 'Should have been initialized.');
  const restrictedStatuses = shaka.Player.restrictedStatuses_;

  const period = this.getPresentationPeriod_();
  let tracksChanged = false;

  let keyIds = Object.keys(keyStatusMap);
  if (keyIds.length == 0) {
    shaka.log.warning(
        'Got a key status event without any key statuses, so we don\'t know ' +
        'the real key statuses. If we don\'t have all the keys, you\'ll need ' +
        'to set restrictions so we don\'t select those tracks.');
  }

  // If EME is using a synthetic key ID, the only key ID is '00' (a single 0
  // byte).  In this case, it is only used to report global success/failure.
  // See note about old platforms in: https://bit.ly/2tpez5Z
  let isGlobalStatus = keyIds.length == 1 && keyIds[0] == '00';

  if (isGlobalStatus) {
    shaka.log.warning(
        'Got a synthetic key status event, so we don\'t know the real key ' +
        'statuses. If we don\'t have all the keys, you\'ll need to set ' +
        'restrictions so we don\'t select those tracks.');
  }

  // Only filter tracks for keys if we have some key statuses to look at.
  if (keyIds.length) {
    period.variants.forEach(function(variant) {
      const streams = shaka.util.StreamUtils.getVariantStreams(variant);

      streams.forEach(function(stream) {
        let originalAllowed = variant.allowedByKeySystem;

        // Only update if we have a key ID for the stream.
        // If the key isn't present, then we don't have that key and the track
        // should be restricted.
        if (stream.keyId) {
          let keyStatus = keyStatusMap[isGlobalStatus ? '00' : stream.keyId];
          variant.allowedByKeySystem =
              !!keyStatus && !restrictedStatuses.includes(keyStatus);
        }

        if (originalAllowed != variant.allowedByKeySystem) {
          tracksChanged = true;
        }
      });  // streams.forEach
    });  // period.variants.forEach
  }  // if (keyIds.length)

  // TODO: Get StreamingEngine to track variants and create
  // getBufferingVariant()
  let activeAudio = this.streamingEngine_.getBufferingAudio();
  let activeVideo = this.streamingEngine_.getBufferingVideo();
  let activeVariant = shaka.util.StreamUtils.getVariantByStreams(
      activeAudio, activeVideo, period.variants);

  if (activeVariant && !activeVariant.allowedByKeySystem) {
    shaka.log.debug('Choosing new streams after key status changed');
    this.chooseStreamsAndSwitch_(period);
  }

  if (tracksChanged) {
    this.onTracksChanged_();
    this.chooseVariant_(period.variants);
  }
};


/**
 * Callback from DrmEngine
 * @param {string} keyId
 * @param {number} expiration
 * @private
 */
shaka.Player.prototype.onExpirationUpdated_ = function(keyId, expiration) {
  if (this.parser_ && this.parser_.onExpirationUpdated) {
    this.parser_.onExpirationUpdated(keyId, expiration);
  }

  let event = new shaka.util.FakeEvent('expirationupdated');
  this.dispatchEvent(event);
};

/**
 * @return {boolean} true if we should stream text right now.
 * @private
 */
shaka.Player.prototype.shouldStreamText_ = function() {
  return this.config_.streaming.alwaysStreamText || this.isTextTrackVisible();
};


/**
 * Applies playRangeStart and playRangeEnd to the given timeline. This will
 * only affect non-live content.
 *
 * @param {shaka.media.PresentationTimeline} timeline
 * @param {number} playRangeStart
 * @param {number} playRangeEnd
 *
 * @private
 */
shaka.Player.applyPlayRange_ = function(timeline,
                                        playRangeStart,
                                        playRangeEnd) {
  if (playRangeStart > 0) {
    if (timeline.isLive()) {
      shaka.log.warning(
          '|playRangeStart| has been configured for live content. ' +
          'Ignoring the setting.');
    } else {
      timeline.setUserSeekStart(playRangeStart);
    }
  }

  // If the playback has been configured to end before the end of the
  // presentation, update the duration unless it's live content.
  const fullDuration = timeline.getDuration();
  if (playRangeEnd < fullDuration) {
    if (timeline.isLive()) {
      shaka.log.warning(
          '|playRangeEnd| has been configured for live content. ' +
          'Ignoring the setting.');
    } else {
      timeline.setDuration(playRangeEnd);
    }
  }
};


/**
 * Checks the given variants and if they are all restricted, throw an
 * appropriate exception.
 *
 * @param {!Array.<shaka.extern.Variant>} variants
 * @private
 */
shaka.Player.prototype.checkRestrictedVariants_ = function(variants) {
  const restrictedStatuses = shaka.Player.restrictedStatuses_;
  const keyStatusMap = this.drmEngine_ ? this.drmEngine_.getKeyStatuses() : {};
  const keyIds = Object.keys(keyStatusMap);
  const isGlobalStatus = keyIds.length && keyIds[0] == '00';

  let hasPlayable = false;
  let hasAppRestrict = false;
  let missingKeys = [];
  let badKeyStatuses = [];

  for (let variant of variants) {
    // TODO: Combine with onKeyStatus_.
    let streams = [];
    if (variant.audio) streams.push(variant.audio);
    if (variant.video) streams.push(variant.video);

    for (let stream of streams) {
      if (stream.keyId) {
        let keyStatus = keyStatusMap[isGlobalStatus ? '00' : stream.keyId];
        if (!keyStatus) {
          if (!missingKeys.includes(stream.keyId)) {
            missingKeys.push(stream.keyId);
          }
        } else if (restrictedStatuses.includes(keyStatus)) {
          if (!badKeyStatuses.includes(keyStatus)) {
            badKeyStatuses.push(keyStatus);
          }
        }
      }
    }

    if (!variant.allowedByApplication) {
      hasAppRestrict = true;
    } else if (variant.allowedByKeySystem) {
      hasPlayable = true;
    }
  }

  if (!hasPlayable) {
    /** @type {shaka.extern.RestrictionInfo} */
    let data = {
      hasAppRestrictions: hasAppRestrict,
      missingKeys: missingKeys,
      restrictedKeyStatuses: badKeyStatuses,
    };
    throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.MANIFEST,
        shaka.util.Error.Code.RESTRICTIONS_CANNOT_BE_MET,
        data);
  }
};


/**
 * Fire an event, but wait a little bit so that the immediate execution can
 * complete before the event is handled.
 *
 * @param {!shaka.util.FakeEvent} event
 * @private
 */
shaka.Player.prototype.delayDispatchEvent_ = async function(event) {
  // Wait until the next interpreter cycle.
  await Promise.resolve();

  // Only dispatch the event if we are still alive.
  if (this.isAlive_) {
    this.dispatchEvent(event);
  }
};

/**
 * Get the normalized languages for a group of streams. If a stream is |null|,
 * it means that there is a variant but no audio stream and the language should
 * be "und".
 *
 * @param {!Array.<?shaka.extern.Stream>} streams
 * @return {!Set.<string>}
 * @private
 */
shaka.Player.getLanguagesFrom_ = function(streams) {
  const languages = new Set();

  for (const stream of streams) {
    if (stream && stream.language) {
      languages.add(shaka.util.LanguageUtils.normalize(stream.language));
    } else {
      languages.add('und');
    }
  }

  return languages;
};


/**
 * Get all permutations of normalized languages and role for a group of streams.
 * If a stream is |null|, it means that there is a variant but no audio stream
 * and the language should be "und".
 *
 * @param {!Array.<?shaka.extern.Stream>} streams
 * @return {!Array.<shaka.extern.LanguageRole>}
 * @private
 */
shaka.Player.getLanguageAndRolesFrom_ = function(streams) {
  /** @type {!Map.<string, !Set>} */
  const languageToRoles = new Map();

  // We must have an empty role so that we will still get a language-role entry.
  const noRoles = [''];

  for (const stream of streams) {
    let language = 'und';
    let roles = noRoles;

    if (stream && stream.language) {
      language = shaka.util.LanguageUtils.normalize(stream.language);
    }

    if (stream && stream.roles.length) {
      roles = stream.roles;
    }

    if (!languageToRoles.has(language)) {
      languageToRoles.set(language, new Set());
    }

    for (const role of roles) {
      languageToRoles.get(language).add(role);
    }
  }

  // Flatten our map to an array of language-role pairs.
  const pairings = [];
  languageToRoles.forEach((roles, language) => {
    for (const role of roles) {
      pairings.push({
        language: language,
        role: role,
      });
    }
  });
  return pairings;
};


/**
 * Get the variants that the user can select. The variants will be based on
 * the period that the playhead is in and what variants are playable.
 *
 * @return {!Array.<shaka.extern.Variant>}
 * @private
 */
shaka.Player.prototype.getSelectableVariants_ = function() {
  // Use the period that is currently playing, allowing the change to affect
  // the "now".
  const currentPeriod = this.getPresentationPeriod_();

  // If we have been called before we load content or after we have unloaded
  // content, then we should return no variants.
  if (currentPeriod == null) { return []; }

  this.assertCorrectActiveStreams_();

  return currentPeriod.variants.filter((variant) => {
    return shaka.util.StreamUtils.isPlayable(variant);
  });
};


/**
 * Get the text streams that the user can select. The streams will be based on
 * the period that the playhead is in and what streams have finished loading.
 *
 * @return {!Array.<shaka.extern.Stream>}
 * @private
 */
shaka.Player.prototype.getSelectableText_ = function() {
  // Use the period that is currently playing, allowing the change to affect
  // the "now".
  const currentPeriod = this.getPresentationPeriod_();

  // If we have been called before we load content or after we have unloaded
  // content, then we should return no streams.
  if (currentPeriod == null) { return []; }

  this.assertCorrectActiveStreams_();

  // Don't show return streams that are still loading.
  return currentPeriod.textStreams.filter((stream) => {
    return !this.loadingTextStreams_.has(stream);
  });
};

/**
 * Get the period that is on the screen. This will return |null| if nothing
 * is loaded.
 *
 * @return {?shaka.extern.Period}
 * @private
 */
shaka.Player.prototype.getPresentationPeriod_ = function() {
  // We need both a manifest and the playhead in order to determine which period
  // we are playing.
  if (this.manifest_ == null) { return null; }
  if (this.playhead_ == null) { return null; }

  const presentationTime = this.playhead_.getTime();

  let lastPeriod = null;

  // Periods are ordered by |startTime|. If we always keep the last period that
  // started before our presentation time, it means we will have the best guess
  // at which period we are presenting.
  for (const period of this.manifest_.periods) {
    if (period.startTime <= presentationTime) {
      lastPeriod = period;
    }
  }

  return lastPeriod;
};


/**
 * Get the variant that we are currently presenting to the user. If we are not
 * showing anything, then we will return |null|.
 *
 * @return {?shaka.extern.Variant}
 * @private
 */
shaka.Player.prototype.getPresentationVariant_ = function() {
  const currentPeriod = this.getPresentationPeriod_();

  return currentPeriod ?
         this.activeStreams_.getVariant(currentPeriod) :
         null;
};


/**
 * Get the text stream that we are either currently presenting to the user or
 * will be presenting will captions are enabled. If we have no text to display,
 * this will return |null|.
 *
 * @return {?shaka.extern.Stream}
 * @private
 */
shaka.Player.prototype.getPresentationText_ = function() {
  const currentPeriod = this.getPresentationPeriod_();

  // Can't have a text stream when there is no period.
  if (currentPeriod == null) { return null; }

  // This is a workaround for the demo page to be able to display the list of
  // text tracks. If no text track is currently active, pick  the one that's\
  // going to be streamed when captions are enabled and mark it as active.
  if (!this.activeStreams_.getText(currentPeriod)) {
    const textStreams = shaka.util.StreamUtils.filterStreamsByLanguageAndRole(
        currentPeriod.textStreams,
        this.currentTextLanguage_,
        this.currentTextRole_);

    if (textStreams.length) {
      this.activeStreams_.useText(currentPeriod, textStreams[0]);
    }
  }

  return this.activeStreams_.getText(currentPeriod);
};


/**
 * Check if we are buffered to the end of the presentation.
 *
 * @return {boolean}
 * @private
 */
shaka.Player.prototype.isBufferedToEnd_ = function() {
  goog.asserts.assert(
      this.video_,
      'We need a video element to get buffering information');
  goog.asserts.assert(
      this.mediaSourceEngine_,
      'We need a media source engine to get buffering information');
  goog.asserts.assert(
      this.manifest_,
      'We need a manifest to get buffering information');

  // This is a strong guarantee that we are buffered to the end, because it
  // means the playhead is already at that end.
  if (this.video_.ended) {
    return true;
  }

  // This means that MediaSource has buffered the final segment in all
  // SourceBuffers and is no longer accepting additional segments.
  if (this.mediaSourceEngine_.ended()) {
    return true;
  }

  // Live streams are "buffered to the end" when they have buffered to the live
  // edge or beyond (into the region covered by the presentation delay).
  if (this.manifest_.presentationTimeline.isLive()) {
    const liveEdge =
        this.manifest_.presentationTimeline.getSegmentAvailabilityEnd();
    const bufferEnd =
        shaka.media.TimeRangesUtils.bufferEnd(this.video_.buffered);

    if (bufferEnd >= liveEdge) {
      return true;
    }
  }

  return false;
};


/**
 * Find the period in |this.manifest_| that contains |variant|. If no period
 * contains |variant| this will return |null|.
 *
 * @param {shaka.extern.Variant} variant
 * @return {?shaka.extern.Period}
 * @private
 */
shaka.Player.prototype.findPeriodWithVariant_ = function(variant) {
  for (const period of this.manifest_.periods) {
    if (period.variants.includes(variant)) {
      return period;
    }
  }

  return null;
};


/**
 * Create an error for when we purposely interrupt a load operation.
 *
 * @return {!shaka.util.Error}
 * @private
 */
shaka.Player.prototype.createAbortLoadError_ = function() {
  return new shaka.util.Error(
      shaka.util.Error.Severity.CRITICAL,
      shaka.util.Error.Category.PLAYER,
      shaka.util.Error.Code.LOAD_INTERRUPTED);
};


/**
 * Key
 * ----------------------
 * D   : Detach Node
 * A   : Attach Node
 * MS  : Media Source Node
 * P   : Manifest Parser Node
 * M   : Manifest Node
 * DRM : Drm Engine Node
 * L   : Load Node
 * U   : Unloading Node
 *
 * Graph Topology
 * ----------------------
 * [D]<-->[A]--->[MS]-->[P]-->[M]--[DRM]-->[L]
 *         ^      |      |     |     |      |
 *         |      |      |     |     |      |
 *        [U]<----/------/-----/-----/------/
 *
 * @param {!shaka.routing.Node} currentlyAt
 * @param {shaka.routing.Payload} currentlyWith
 * @param {!shaka.routing.Node} wantsToBeAt
 * @param {shaka.routing.Payload} wantsToHave
 * @return {?shaka.routing.Node}
 * @private
 */
shaka.Player.prototype.getNextStep_ = function(
    currentlyAt, currentlyWith, wantsToBeAt, wantsToHave) {
  let next = null;

  // Detach is very simple, either stay in detach (because |detach| was called
  // while in detached) or go somewhere that requires us to attach to an
  // element.
  if (currentlyAt == this.detachNode_) {
    next = wantsToBeAt == this.detachNode_ ?
           this.detachNode_ :
           this.attachNode_;
  }

  if (currentlyAt == this.attachNode_) {
    next = this.getNextAfterAttach_(wantsToBeAt, currentlyWith, wantsToHave);
  }

  if (currentlyAt == this.mediaSourceNode_) {
    next = this.getNextAfterMediaSource_(
        wantsToBeAt, currentlyWith, wantsToHave);
  }

  if (currentlyAt == this.parserNode_) {
    next = this.getNextMatchingAllDependencies_(
        /* destination= */ this.loadNode_,
        /* next= */ this.manifestNode_,
        /* reset= */ this.unloadNode_,
        /* goingTo= */ wantsToBeAt,
        /* has= */ currentlyWith,
        /* wants= */ wantsToHave);
  }

  if (currentlyAt == this.manifestNode_) {
    next = this.getNextMatchingAllDependencies_(
        /* destination= */ this.loadNode_,
        /* next= */ this.drmNode_,
        /* reset= */ this.unloadNode_,
        /* goingTo= */ wantsToBeAt,
        /* has= */ currentlyWith,
        /* wants= */ wantsToHave);
  }

  // For DRM, we have two options "load" or "unload". If all our constraints are
  // met, we can go to "load". If anything is off, we must go back to "unload"
  // to reset.
  if (currentlyAt == this.drmNode_) {
    next = this.getNextMatchingAllDependencies_(
        /* destination= */ this.loadNode_,
        /* next= */ this.loadNode_,
        /* reset= */ this.unloadNode_,
        /* goingTo= */ wantsToBeAt,
        /* has= */ currentlyWith,
        /* wants= */ wantsToHave);
  }

  // Load is very simple, always go to unload next because after we have started
  // playing content, we need to tear-down everything before loading anything
  // else.
  if (currentlyAt == this.loadNode_) {
    next = this.unloadNode_;
  }

  if (currentlyAt == this.unloadNode_) {
    next = this.getNextAfterUnload_(wantsToBeAt, currentlyWith, wantsToHave);
  }

  goog.asserts.assert(next, 'Missing next step!');
  return next;
};


/**
 * @param {!shaka.routing.Node} goingTo
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {?shaka.routing.Node}
 * @private
 */
shaka.Player.prototype.getNextAfterAttach_ = function(goingTo, has, wants) {
  // Attach and detach are the only two nodes that we can directly go
  // back-and-forth between.
  if (goingTo == this.detachNode_) { return this.detachNode_; }

  // If we are going anywhere other than detach, then we need the media element
  // to match, if they don't match, we need to go through detach first.
  if (has.mediaElement != wants.mediaElement) { return this.detachNode_; }

  // If we are already in attached, and someone calls |attach| again (to the
  // same video element), we can handle the redundant request by re-entering
  // our current state.
  if (goingTo == this.attachNode_) { return this.attachNode_; }

  // The next step from attached to loaded is through media source.
  if (goingTo == this.mediaSourceNode_ || goingTo == this.loadNode_) {
    return this.mediaSourceNode_;
  }

  // We are missing a rule, the null will get caught by a common check in
  // the routing system.
  return null;
};


/**
 * @param {!shaka.routing.Node} goingTo
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {?shaka.routing.Node}
 * @private
 */
shaka.Player.prototype.getNextAfterMediaSource_ = function(
    goingTo, has, wants) {
  // We can only go to parse manifest or unload. If we want to go to load and
  // we have the right media element, we can go to parse manifest. If we don't,
  // no matter where we want to go, we must go through unload.
  if (goingTo == this.loadNode_ && has.mediaElement == wants.mediaElement) {
    return this.parserNode_;
  } else {
    // Right now the unload node is responsible for tearing down all playback
    // components (including media source). So since we have created media
    // source, we need to unload since our dependencies are not compatible.
    //
    // TODO: We are structured this way to maintain a historic structure. Going
    //       forward, there is no reason to restrict ourselves to this. Going
    //       forward we should explore breaking apart |onUnload| and develop
    //       more meaningful terminology around tearing down playback resources.
    return this.unloadNode_;
  }
};


/**
 * @param {!shaka.routing.Node} goingTo
 * @param {shaka.routing.Payload} has
 * @param {shaka.routing.Payload} wants
 * @return {?shaka.routing.Node}
 * @private
 */
shaka.Player.prototype.getNextAfterUnload_ = function(goingTo, has, wants) {
  if (goingTo == this.detachNode_) { return this.detachNode_; }

  // If we are going anywhere other than detach, then we need the media element
  // to match, if they don't match, we need to go through detach first.
  if (has.mediaElement != wants.mediaElement) { return this.detachNode_; }

  if (goingTo == this.mediaSourceNode_ ||
      goingTo == this.attachNode_ ||
      goingTo == this.loadNode_) {
    return this.attachNode_;
  }

  // We are missing a rule, the null will get caught by a common check in
  // the routing system.
  return null;
};


/**
 * A general method used to handle routing when we can either than one step
 * toward our destination (while all our dependencies match) or go to a node
 * that will reset us so we can try again.
 *
 * @param {!shaka.routing.Node} destinationNode
 *   What |goingTo| must be for us to step toward |nextNode|. Otherwise we will
 *   go to |resetNode|.
 * @param {!shaka.routing.Node} nextNode
 *   The node we will go to next if |goingTo == destinationNode| and all
 *   dependencies match.
 * @param {!shaka.routing.Node} resetNode
 *   The node we will go to next if |goingTo != destinationNode| or any
 *   dependency does not match.
 * @param {!shaka.routing.Node} goingTo
 *   The node that the walker is trying to go to.
 * @param {shaka.routing.Payload} has
 *   The payload that the walker currently has.
 * @param {shaka.routing.Payload} wants
 *   The payload that the walker wants to have when iy gets to |goingTo|.
 * @return {shaka.routing.Node}
 * @private
 */
shaka.Player.prototype.getNextMatchingAllDependencies_ = function(
        destinationNode, nextNode, resetNode, goingTo, has, wants) {
  if (goingTo == destinationNode &&
      has.mediaElement == wants.mediaElement &&
      has.uri == wants.uri &&
      has.mimeType == wants.mimeType &&
      has.factory == wants.factory) {
    return nextNode;
  }

  return resetNode;
};


/**
 * @return {shaka.routing.Payload}
 * @private
 */
shaka.Player.prototype.createEmptyPayload_ = function() {
  return {
    factory: null,
    mediaElement: null,
    mimeType: null,
    startTime: null,
    startTimeOfLoad: null,
    uri: null,
  };
};


/**
 * Using a promise, wrap the listeners returned by |Walker.startNewRoute|. This
 * will work for most usages in |Player| but should not be used for special
 * cases.
 *
 * This will connect |onCancel|, |onEnd|, |onError|, and |onSkip| with |resolve|
 * and |reject| but will leave |onStart| unset.
 *
 * @param {shaka.routing.Walker.Listeners} listeners
 * @return {!Promise}
 * @private
 */
shaka.Player.prototype.wrapWalkerListenersWithPromise_ = function(listeners) {
  return new Promise((resolve, reject) => {
    listeners.onCancel = () => reject(this.createAbortLoadError_());
    listeners.onEnd = () => resolve();
    listeners.onError = (e) => reject(e);
    listeners.onSkip = () => reject(this.createAbortLoadError_());
  });
};
