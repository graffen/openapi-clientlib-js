/**
 * @module saxo/openapi/streaming/subscription
 * @ignore
 */

import { extend } from '../../utils/object';
import log from '../../log';

//-- Local variables section --

/**
 * The static counter to generate unique reference id's.
 */
var referenceIdCounter = 0;

const STATE_SUBSCRIBE_REQUESTED = 0x1;
const STATE_SUBSCRIBED = 0x2;
const STATE_UNSUBSCRIBE_REQUESTED = 0x4;
const STATE_UNSUBSCRIBED = 0x8;

const TRANSITIONING_STATES = STATE_SUBSCRIBE_REQUESTED | STATE_UNSUBSCRIBE_REQUESTED;

const ACTION_SUBSCRIBE = 0x20;
const ACTION_UNSUBSCRIBE = 0x40;

const DEFAULT_REFRESH_RATE_MS = 1000;
const MIN_REFRESH_RATE_MS = 100;

const LOG_AREA = "Subscription";

//-- Local methods section --

/**
 * Call to actually do a subscribe.
 */
function subscribe() {

	// capture the reference id so we can tell in the response whether it is the latest call
	// was using createGUID to create the reference id, but the old library just does this, which is simpler
	var referenceId = String(referenceIdCounter++);
	this.referenceId = referenceId;

	// reset any updates before subscribed
	this.updatesBeforeSubscribed = null;

	var data = extend({}, this.subscriptionData, {
		ContextId: this.streamingContextId,
		ReferenceId: this.referenceId
	});

	log.debug(LOG_AREA, "starting..", {serviceGroup: this.serviceGroup, url: this.url});
	this.currentState = STATE_SUBSCRIBE_REQUESTED;
	this.transport.post(this.serviceGroup , this.url + "/active", null, { body: data })
		.then(onSubscribeSuccess.bind(this, referenceId))
		.catch(onSubscribeError.bind(this, referenceId));
}

/**
 * Does an actual unsubscribe.
 */
function unsubscribe() {

	this.currentState = STATE_UNSUBSCRIBE_REQUESTED;
	// capture the reference id so we can tell in the response whether it is the latest call
	var referenceId = this.referenceId;

	this.transport.delete(this.serviceGroup , this.url + "/{contextId}/{referenceId}", { contextId: this.streamingContextId, referenceId: this.referenceId })
		.then(onUnsubscribeSuccess.bind(this, referenceId))
		.catch(onUnsubscribeError.bind(this, referenceId));
}

/**
 * Queues or performs an action based on the curent state.
 * @param action
 */
function tryPerformAction(action) {
	if (!this.connectionAvailable || TRANSITIONING_STATES & this.currentState) {
		this.nextAction = action;
	} else {
		performAction.call(this, action);
	}
}

/**
 * Callback for when the subscription is ready to perform the next action.
 */
function onReadyToPerformNextAction() {
	if (!this.connectionAvailable) {
		return;
	}
	if (this.nextAction) {
		performAction.call(this, this.nextAction);
	}
}

/**
 * Performs an action to a subscription based on the current state.
 * @param action
 */
function performAction(action) {
	switch(action) {
		case ACTION_SUBSCRIBE:
			switch(this.currentState) {
				case STATE_SUBSCRIBED:
					break;
				case STATE_UNSUBSCRIBED:
					subscribe.call(this);
					break;
				default:
					log.error(LOG_AREA, "unanticipated state", {state: this.currentState, action: action});
			}
			break;
		case ACTION_UNSUBSCRIBE:
			switch(this.currentState) {
				case STATE_SUBSCRIBED:
					unsubscribe.call(this);
					break;
				case STATE_UNSUBSCRIBED:
					break;
				default:
					log.error(LOG_AREA, "unanticipated state", {state: this.currentState, action: action});
			}
			break;
		default:
			throw new Error("unrecognised action " + action);
	}
	this.nextAction = null;
}

/**
 * Handles the response to the initial REST request that creates the subscription.
 * {Object} result
 * {string} result.State The current state (Active/Suspended)
 * {string} result.Format The media type (RFC 2046), of the serialized data updates that are streamed to the client.
 * {string} result.ContextId The streaming context id that this response is associated with.
 * {number=0} result.InactivityTimeout The time (in seconds) that the client should accept the subscription to be inactive before considering it invalid.
 * {number=0} result.RefreshRate Actual refresh rate assigned to the subscription according to the customers SLA.
 * {Object} result.Snapshot Snapshot of the current data available
 * {string} result.Tag Client specified tag assigned to the subscription, if specified in the request.
 */
function onSubscribeSuccess(referenceId, result) {

	var responseData = result.response;

	if (referenceId !== this.referenceId) {
		log.warn(LOG_AREA, "Received an Ok subscribe response for subscribing a subscription that has afterwards been reset - ignoring");
		// we could send the contextId as well an attempt a unsubscribe, but its hard to guess what could lead to this.
		// - (reset by disconnect/reconnect from streaming) we started subscribing, then web sockets was disconnected, but the server doesn't know it yet
		//   - in this case the contextId should be changed and the server will drop the old session soon. we won't receive updates
		// - (reset by streaming control message) we started subscribing, then we get a web socket reset event before the rest server responded
		//   - in this case the contextId should be the same and the server itself has told us the subscription is dead
		// - (reset by heartbeat lapse) - this indicates a bug in the library since this shouldn't happen
		//   - in this case the contextId should be the same and we will probably get messages that cannot be matched to a subscription
		return;
	}

	this.currentState = STATE_SUBSCRIBED;

	this.inactivityTimeout = responseData.InactivityTimeout || 0;

	if (this.inactivityTimeout === 0) {
		log.warn(LOG_AREA, "inactivity timeout is 0 - interpretting as never timeout. Remove warning if normal.", result);
	}

	onActivity.call(this);

	if (this.onSubscriptionCreated) {
		this.onSubscriptionCreated();
	}

	// do not fire events if we are waiting to unsubscribe
	if (this.nextAction !== ACTION_UNSUBSCRIBE) {
	    try {
	        this.onUpdate(responseData.Snapshot, this.UPDATE_TYPE_SNAPSHOT);
	    }
	    catch(ex) {
	        log.error(LOG_AREA, "exception occurred in streaming snapshot update callback");
	    }

		if (this.updatesBeforeSubscribed) {
			for(let i = 0, updateMsg; updateMsg = this.updatesBeforeSubscribed[i]; i++) {
				this.onStreamingData(updateMsg);
			}
		}
	}
	this.updatesBeforeSubscribed = null;

	onReadyToPerformNextAction.call(this);
}

/**
 * Called when a subscribe errors
 * @param response
 */
function onSubscribeError(referenceId, response) {
	if (referenceId !== this.referenceId) {
		log.debug(LOG_AREA, "Received an error response for subscribing a subscription that has afterwards been reset - ignoring");
		return;
	}

	this.currentState = STATE_UNSUBSCRIBED;
	log.error(LOG_AREA, "An error occurred subscribing", { response: response, url: this.url });

	// if we are unsubscribed, do not fire the error handler
	if (this.nextAction !== ACTION_UNSUBSCRIBE) {
		if (this.onError) {
			this.onError(response);
		}
	}
	onReadyToPerformNextAction.call(this);
}

/**
 * Called after subscribe is successful
 * @param referenceId
 * @param response
 */
function onUnsubscribeSuccess(referenceId, response) {
	if (referenceId !== this.referenceId) {
		log.debug(LOG_AREA, "Received an error response for subscribing a subscription that has afterwards been reset - ignoring");
		// we were unsubscribing when reset and the unsubscribe succeeded
		// return because we may have been asked to subscribe after resetting
		return;
	}

	this.currentState = STATE_UNSUBSCRIBED;
	onReadyToPerformNextAction.call(this);
}

/**
 * Called when a unsubscribe errors
 * @param response
 */
function onUnsubscribeError(referenceId, response) {
	if (referenceId !== this.referenceId) {
		log.error(LOG_AREA, "Received an error response for unsubscribing a subscription that has afterwards been reset - ignoring");
		return;
	}

	this.currentState = STATE_UNSUBSCRIBED;
	log.error(LOG_AREA, "An error occurred unsubscribing", { response: response, url: this.url });
	onReadyToPerformNextAction.call(this);
}

/**
 * Resets the subscription activity
 */
function onActivity() {
	this.latestActivity = new Date().getTime();
}

//-- Exported methods section --

/**
 * A subscription to a resource, which streams updates.
 *
 * This class should not be constructed directly, it should instead be created via the
 * {@link saxo.openapi.Streaming#createSubscription} factory method.
 *
 * @class
 * @alias saxo.openapi.StreamingSubscription
 */
function Subscription(streamingContextId, transport, serviceGroup, url, subscriptionArgs, onSubscriptionCreated, onUpdate, onError) {

	/**
	 * The streaming context id identifies the particular streaming connection that this subscription will use
	 * @type {string}
	 */
	this.streamingContextId = streamingContextId;

	/**
	 * The reference id is used to identify this subscription
	 * @type {string}
	 */
	this.referenceId = null;

	this.transport = transport;
	this.serviceGroup = serviceGroup;
	this.url = url;
	this.onUpdate = onUpdate;
	this.onError = onError;
	this.onSubscriptionCreated = onSubscriptionCreated;
	this.subscriptionData = extend({}, subscriptionArgs);

	if (!this.subscriptionData.RefreshRate) {
		this.subscriptionData.RefreshRate = DEFAULT_REFRESH_RATE_MS;
	} else {
		if (this.subscriptionData.RefreshRate < MIN_REFRESH_RATE_MS) {
			log.warn(LOG_AREA, "Low refresh rate. This has been rounded up to the minimum.", { minimumRate: MIN_REFRESH_RATE_MS });
			this.subscriptionData.RefreshRate = MIN_REFRESH_RATE_MS;
		}
	}
	this.tag = subscriptionArgs.Tag;
	this.connectionAvailable = true;

	this.currentState = STATE_UNSUBSCRIBED;
}

Subscription.prototype.UPDATE_TYPE_SNAPSHOT = 1;
Subscription.prototype.UPDATE_TYPE_DELTA = 2;

/**
 * Defines the name of the property on data used to indicate that the data item is a deletion, rather than a
 * insertion / update.
 * @type {string}
 */
Subscription.prototype.OPENAPI_DELETE_PROPERTY = "__meta_deleted";

/**
 * This assumes the subscription is dead and subscribes again. If unsubscribed or awaiting a unsubscription, this is ignored.
 * It should be used in the case of errors, such as the subscription becoming orphaned and when the server asks us to reset a subscription.
 * @private
 */
Subscription.prototype.reset = function() {

	switch(this.currentState) {
		case STATE_UNSUBSCRIBED:
		case STATE_UNSUBSCRIBE_REQUESTED:
			// do not do anything if we are on our way to unsubscribed unless the next action would be to subscribe
			if (this.nextAction & ACTION_SUBSCRIBE) {
				break;
			}
			return;
		case STATE_SUBSCRIBE_REQUESTED:
			// we could have been in the process of subscribing when disconnected. we would need to subscribe with a new streamingContextId
			break;
		case STATE_SUBSCRIBED:
			break;
		default:
			log.error(LOG_AREA, "reset was called but subscription is in an unknown state");
			return;
	}

	this.nextAction = null;

	// do not unsubscribe because a reset happens when the existing subscription is broken
	//  * on a new connection (new context id, subscription will be cleaned up)
	//  * server reset instruction (server is telling us subscription is broken)
	//  * subscription is orphaned (meaning subscription is dead).

	// set the state to unsubscribed, since that is what we are now assuming
	this.currentState = STATE_UNSUBSCRIBED;

	// subscribe... because the state is unsubscribed this will go ahead unless the connection is unavailable
	this.onSubscribe();
};

/**
 * Try to subscribe.
 * @private
 */
Subscription.prototype.onSubscribe = function() {

	if (this.isDisposed) {
		throw new Error('Subscribing a disposed subscription - you will not get data');
	}

	tryPerformAction.call(this, ACTION_SUBSCRIBE);
};

/**
 * Try to unsubscribe.
 * @private
 */
Subscription.prototype.onUnsubscribe = function() {

	if (this.isDisposed) {
		log.warn('Unsubscribing a disposed subscription - this is not necessary');
	}

	tryPerformAction.call(this, ACTION_UNSUBSCRIBE);
};

/**
 * Tells us we are now disposed
 * @private
 */
Subscription.prototype.dispose = function() {

	this.isDisposed = true;
};

/**
 * Tell the subscription that the connection is unavailable.
 * @private
 */
Subscription.prototype.onConnectionUnavailable = function() {
	this.connectionAvailable = false;
};

/**
 * Tell the subscription that the connection is available and it can perform any queued action.
 * @private
 */
Subscription.prototype.onConnectionAvailable = function() {
	this.connectionAvailable = true;
	onReadyToPerformNextAction.call(this);
};

/**
 * Handles the 'data' event raised by Streaming.
 * @private
 * @returns {boolean} false if the update is not for this subscription
 */
Subscription.prototype.onStreamingData = function(message) {

	onActivity.call(this);


	switch(this.currentState) {
		// if we are unsubscribed or trying to unsubscribe then ignore the data
		case STATE_UNSUBSCRIBE_REQUESTED:
			return;
		case STATE_UNSUBSCRIBED:
			return false;
		// we received a delta before we got initial data
		case STATE_SUBSCRIBE_REQUESTED:
			this.updatesBeforeSubscribed = this.updatesBeforeSubscribed || [];
			this.updatesBeforeSubscribed.push(message);
			return;
		// the normal state, go ahead
		case STATE_SUBSCRIBED:
			break;
		default:
			log.error(LOG_AREA, "unanticipated state", this.currentState);
	}

	try {
		this.onUpdate(message, this.UPDATE_TYPE_DELTA);
	}
	catch(error) {
	    log.error(LOG_AREA, "exception occurred in streaming delta update callback", error);
	}
};

/**
 * Handles a heartbeat from the server.
 * @private
 */
Subscription.prototype.onHeartbeat = function() {
	onActivity.call(this);
};

/**
 * Returns the time in ms till the subscription would be orphaned.
 * @param now - The current time as a reference (e.g. Date.now()).
 * @private
 */
Subscription.prototype.timeTillOrphaned = function(now) {

	// this works because there are no suspended and resume states.
	// once subscribed, orphan finder will be notified.
	if (!this.connectionAvailable || this.currentState !== STATE_SUBSCRIBED || this.inactivityTimeout === 0) {
		return Infinity;
	}

	// Follows the same pattern as the old library, not giving any grace period for receiving a heartbeat
	// if it was required, it could be added on here

	var diff = now - this.latestActivity;

	return this.inactivityTimeout * 1000 - diff;
};

//-- Export section --

export default Subscription;
