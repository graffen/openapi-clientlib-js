/**
 * @module saxo/openapi/batch-util
 * @ignore
 */

import log from '../log';

//-- Local variables section --

const requestRx = /X-Request-Id: ([0-9]+)/;
const httpCodeRx = /HTTP\/1.1 ([0-9]+)/;

const LOG_AREA = "batch";

//-- Local methods section --

//-- Exported methods section --

/**
 * Utilities to build and parse batch requests
 * @namespace saxo.openapi.batchUtil
 */


/**
 * Parses the response from a batch call.
 * @name saxo.openapi.batchUtil.parse
 * @param {string} responseText
 * @returns {Array.<{status:string, response: Object}>} An array of responses, in the position of the response id's.
 */
function parse(responseText) {

	if(!responseText) {
		throw new Error("Required Parameter: responseText in batch parse");
	}

	var lines = responseText.split('\r\n');
	var responseBoundary = lines[0];
	var currentData = null;
	var requestId = null;
	var responseData = [];

	for(let i = 0, l = lines.length; i < l; i++) {
		let line = lines[i];
		if (line.length) {

			if (!responseData[requestId]) {
				requestId = line.match(requestRx);
				if (requestId) {
					requestId = parseInt(requestId[1], 10);
					responseData[requestId] = {};
				}
			}

			if (line.indexOf(responseBoundary) === 0) {
				if (currentData) {
					requestId = (requestId === null ? responseData.length : requestId);
					responseData[requestId] = currentData;
				}

				requestId = null;
				currentData = {};
			}
			else if (currentData) {
				if (!currentData.status) {
					var statusMatch = line.match(httpCodeRx);
					if (statusMatch) {
						// change the status to be a number to match fetch
						currentData.status = Number(statusMatch[1]);
					}
				}
				else if (!currentData.response) {
					var firstCharacter = line.charAt(0);
					if (firstCharacter === '{' || firstCharacter === '[') {
						try {
							currentData.response = JSON.parse(line);
						} catch (ex) {
							log.warning(LOG_AREA, "Unexpected exception parsing json. Ignoring.", ex);
						}
					}
				}
			}
		}
	}

	return responseData;
}

/**
 * Builds up a string of the data for a batch request.
 * @name saxo.openapi.batchUtil.build
 * @param {Array.<{method: string, headers: ?Object.<string, string>, url: string, data: ?string}>} subRequests - The sub requests of the batch.
 * @param {string} boundary - The boundary identifier. This should be a GUID.
 * @param {string} authToken - The authentication token.
 * @param {string} host - The host of the sender.
 */
function build(subRequests, boundary, authToken, host) {

	if(!subRequests || !boundary || !authToken || !host) {
		throw new Error("Missing required parameters: batch build requires all 4 parameters");
	}

	var body = [];

	for(let i = 0, l = subRequests.length; i < l; i++) {
		let request = subRequests[i];
		let method = request.method.toUpperCase();

		body.push('--' + boundary);
		body.push('Content-Type: application/http; msgtype=request', '');

		body.push(method + ' ' + request.url + ' HTTP/1.1');
		body.push('X-Request-Id: ' + i);
		if (request.headers) {
			for(let header in request.headers) {
				if (request.headers.hasOwnProperty(header)) {
					body.push(header + ": " + request.headers[header]);
				}
			}
		}

		body.push("Authorization" + ': ' + authToken);

		/* Don't care about content type for requests that have no body. */
		if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
			body.push('Content-Type: application/json; charset=utf-8');
		}

		body.push('Host: ' + host, '');
		body.push(request.data || "");
	}

	body.push('--' + boundary + '--', '');
	return body.join('\r\n');
}

//-- Export section --

export {parse, build};
