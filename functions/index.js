// Copyright 2016, Lewis Liu(lewisliu116@gmail.com)
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

process.env.DEBUG = 'actions-on-google:*';

const url = require('url');
const { DialogflowApp, Responses } = require('actions-on-google');
const { RichResponse, BasicCard } = Responses;
const functions = require('firebase-functions');
const maps = require('@google/maps');
const Request = require('request');

const config = functions.config();

const client = maps.createClient({
  key: config.maps.key
});

// Dialogflow actions
const Actions = {
  WELCOME: 'input.welcome',
  REQUEST_LOC_PERMISSION: 'request.location.permission',
  HANDLE_DATA: 'handle.data',
  UNHANDLED_DEEP_LINK: 'deeplink.unknown',
  CUSTOM_ADDRESS: 'address.address-fallback'
};

// AIRNOW
const AIRNOW_URL = "http://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude=<LAT>&longitude=<LONG>&distance=50&API_KEY=<KEY>";
const APP_KEY = "";
var DEFAULT_LAT;
var DEFAULT_LONG;
var DEFFAULT_CITY;

// Google Map API
const STATIC_MAPS_ADDRESS = 'https://maps.googleapis.com/maps/api/staticmap';
const STATIC_MAPS_SIZE = '600x400';
const staticMapsURL = url.parse(STATIC_MAPS_ADDRESS);
staticMapsURL.query = {
  key: config.maps.key,
  size: STATIC_MAPS_SIZE,
};

/**
 * Constructs a rich response consisting of a simple response and a basic card whose image shows
 * a Static Maps view centered on a city.
 *
 * @param {string} city
 * @param {string} speech
 */
const locationResponse = (city, lat, long, speech) => {
  staticMapsURL.query.center = city;
  staticMapsURL.query.markers = "color:red|" + lat + "," + long;
  console.log(staticMapsURL.query);
  const mapViewURL = url.format(staticMapsURL);
  return new RichResponse()
    .addSimpleResponse(speech)
    .addBasicCard(new BasicCard().setImage(mapViewURL, 'Location Map'));
};

/**
 * Sanitize template literal inputs by escaping characters into XML entities to use in SSML
 * Also normalize the extra spacing for better text rendering in SSML
 * A tag function used by ES6 tagged template literals
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Template_literals#Tagged_template_literals
 *
 * @example
 * const equation = '"1 + 1 > 1"';
 * const response = ssml`
 *   <speak>
 *     ${equation}
 *   </speak>
 * `;
 * // Equivalent to ssml`\n  <speak>\n    ${equation}\n  </speak>\n`
 * console.log(response);
 * // Prints: '<speak>&quot;1 + 1 &gt; 1&quot;</speak>'
 *
 * @param {TemplateStringsArray} template Non sanitized constant strings in the template literal
 * @param {Array<string>} inputs Computed expressions to be sanitized surrounded by ${}
 */
const ssml = (template, ...inputs) => template.reduce((out, str, i) => i
  ? out + (
    inputs[i - 1]
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  ) + str
  : str
).trim().replace(/\s+/g, ' ').replace(/ </g, '<').replace(/> /g, '>');

const COLOR_CODE = {
	"red" : "is strictly prohibited. Please change location and check again",
	"orange" : "is restricted. Action is required to get authorization to fly your drone in this area",
	"yellow" : "is restricted. Please check advisories and use caution when flying your drone",
	"green" :"has no restrictions, but please use caution when flying your drone"
}

const responses = {
  /** @param {string} city 
	* @param {string} color
	*/
  sayLocation: (city, lat, long, def, weather, wind) => locationResponse(city, lat, long, ssml`
	      <speak>
	        Here are the results: <break time="500ms"/>
	        Air Quality at ${city} is ${def}.<break time="500ms"/>
	        The Air Quality Index is ${aqi}. <sub alias="Particulate Matter 2.5">PM2.5</sub>.
	      </speak>
	    `),
  greetUser: ssml`
    <speak>
      Welcome to Air Quality Assistant!
      <break time="500ms"/>
  	  We can get you information about Air Quality in your area from the United States EPA, Air Now Program
	  <break time="500ms"/>
      Do you want us to use your current location, or do you want to check an address?
    </speak>
  `,
  /** @param {string} input */
  unhandledDeepLinks: input => ssml`
    <speak>
      We're sorry, we didn't understand ${input}. Please try again. 
    </speak>
  `,
  flyDroneError: ssml`
    <speak>
      Oops!
      <break time="1s"/>
      Something went wrong, and we couldn't get the information you asked for.
	  <break time="250ms"/>
      Please try again or check www.airnow.gov for more information.
    </speak>
  `,
  coarseLocation: city => ssml`
    <speak>
      We weren't able to find your precise location using your device.
	  <break time="250ms"/>
      Your device's current location ${city} is not precise enough to return accurate information.
	  <break time="500ms"/>
	  Please use a specific address instead.
    </speak>
  `,
  noCoarseLocation: ssml`
    <speak>
      Oops!
      <break time="1s"/>
      We didn't see a location set in your device. 
	  <break time="250ms"/>
      But you can try again with a specific address.
    </speak>
  `,
  permissionReason: 'To find your device location',
  notificationText: 'To find your location...'
};

/**
 * @typedef {Object} AppData
 * @property {string=} requestedPermission
 */

class FlyDrone {
  /**
   * @param {ExpressRequest} req
   * @param {ExpressResponse} res
   */
  constructor (req, res) {
    //console.log('Headers', JSON.stringify(req.headers, null, 2));
    console.log('Body', JSON.stringify(req.body, null, 2));

    this.app = new DialogflowApp({
      request: req,
      response: res
    });

    /** @type {AppData} */
    this.data = this.app.data;
    this.permissions = this.app.SupportedPermissions;
  }

  run () {
    /** @type {*} */
    const map = this;
    const action = this.app.getIntent();
    console.log(action);
    if (!action) {
      return this.app.tell(responses.flyDroneError);
    }
    const result = map[action]();
    if (result instanceof Promise) {
      result.catch(/** @param {Error} e */ e => {
        console.log('Error', e.toString(), e.stack);
        this.app.tell(responses.flyDroneError);
      });
    }
  }

  /**
   * Gets the city name from results returned by Google Maps reverse geocoding from coordinates.
   * @param {number} latitude
   * @param {number} longitude
   * @return {Promise<string>}
   */
  coordinatesToCity (latitude, longitude) {
    const latlng = [latitude, longitude];
    return new Promise((resolve, reject) => client.reverseGeocode({ latlng },
      /**
       * @param {Error} e
       * @param {Object<string, *>} response
       */
      (e, response) => {
        if (e) {
          return reject(e);
        }
        const { results } = response.json;
        /** @type {Array<Object<string, *>>} */
        const components = results[0].address_components;
        for (const component of components) {
          for (const type of component.types) {
            if (type === 'locality') {
              return resolve(component.long_name);
            }
          }
        }
		console.log("Could not parse city name from Google Maps results");
        reject(new Error('Could not parse city name from Google Maps results'));
      }
    ));
  }
  
 /**
  * Gets the coordinates from results returned by Google Maps geocoding from address.
  * @param {string} address
  * @return {Promise geo[lat, long]}
  */
  cityToCoordniates (address) {
      return new Promise((resolve, reject) => client.geocode({ address },
        /**
         * @param {Error} e
         * @param {Object<string, *>} response
         */
        (e, response) => {
          if (e) {
            return reject(e);
          }
          const { results } = response.json;
          /** @type {Array<Object<string, *>>} */
          const gloc = results[0].geometry.location;
		  console.log(results[0].geometry.location);
          if (gloc) {
			  const latitude = gloc.lat;
			  const longitude = gloc.lng;
			  return resolve({latitude, longitude});
          }
		  console.log("Could not obtain coornidate from Google Maps results.");
          reject(new Error('Could not obtain coornidate from Google Maps results'));
        }
      ));
  }

  fetchAirMap() {
	  if (!this.DEFAULT_CITY && (!this.DEFAULT_LAT || !this.DEFAULT_LONG)) {
		  console.log("cannot resolve location.");
		  return Promise.reject(new Error('We cannot resolve the location.'));
	  }
	const url = AIRNOW_URL.replace("<LAT>", this.DEFAULT_LAT).replace("<LONG>", this.DEFAULT_LONG).replace("<KEY>", this.API_KEY);
	console.log(url);
	var options = {
	  url: url
	};
	Request(options, (error, response, body) => {
		if (!error && response.statusCode == 200) {
			var info = JSON.parse(body);
			console.log(info.data.advisory_color + ", " + COLOR_CODE[info.data.advisory_color] + ", " + info.data.weather.condition + ", "+ info.data.weather.wind.speed);
			return this.app.tell(responses.sayLocation(this.DEFAULT_CITY, this.DEFAULT_LAT, this.DEFAULT_LONG, COLOR_CODE[info.data.advisory_color],  info.data.weather.condition, info.data.weather.wind.speed.toString()));
		}
		console.log(error);
		console.log(response.statusCode);
		return Promise.reject(new Error('We cannot retrieve flight data at the moment'));
	});
  }
  
  [Actions.WELCOME] () {
    this.app.ask(responses.greetUser);
  }

  [Actions.UNHANDLED_DEEP_LINK] () {
    this.app.ask(responses.unhandledDeepLinks(this.app.getRawInput()));
  }

  [Actions.REQUEST_LOC_PERMISSION] () {
    // If the request comes from a phone, we can't use coarse location.
    const requestedPermission = this.app.hasSurfaceCapability(this.app.SurfaceCapabilities.SCREEN_OUTPUT)
      ? this.permissions.DEVICE_PRECISE_LOCATION
      : this.permissions.DEVICE_COARSE_LOCATION;
    this.data.requestedPermission = requestedPermission;
    if (!this.app.isPermissionGranted()) {
       return this.app.askForPermission(responses.permissionReason, requestedPermission);
    }
  }
  
  [Actions.CUSTOM_ADDRESS] () {
	  console.log("query user input address: " + this.app.getRawInput());
	  this.DEFAULT_CITY = this.app.getRawInput();
  	  return this.cityToCoordniates(this.app.getRawInput()).then(geo => {
  	  	  this.DEFAULT_LAT = geo.latitude;
  		  this.DEFAULT_LONG = geo.longitude;
  		  console.log("calling from aprox location subroutine");
  		  this.fetchAirMap();
		  
  	  });
  }
  
  [Actions.HANDLE_DATA] () {
      if (!this.app.isPermissionGranted()) {
		console.log("Permission not granted by user.");
        return Promise.reject(new Error('Permission not granted'));
      }
      const requestedPermission = this.data.requestedPermission;
      if (requestedPermission === this.permissions.DEVICE_COARSE_LOCATION) {
        // If we requested coarse location, it means that we're on a speaker device.
        this.DEFAULT_CITY = this.app.getDeviceLocation().city;
		if (typeof this.app.getDeviceLocation().city == 'undefined' || !this.DEFAULT_CITY) {
			console.log("no coarse location set for this device.");
			this.app.tell(responses.noCoarseLocation);
		}
		else {
			console.log("log coarse location at [" + this.DEFAULT_CITY + "]");
  	    	this.app.tell(responses.coarseLocation(this.DEFAULT_CITY));
		}
      }
      else if (requestedPermission === this.permissions.DEVICE_PRECISE_LOCATION) {
        // If we requested precise location, it means that we're on a phone.
        // Because we will get only latitude and longitude, we need to reverse geocode
        // to get the city.
        const { coordinates } = this.app.getDeviceLocation();
  	    this.DEFAULT_LAT= coordinates.latitude;
  	    this.DEFAULT_LONG = coordinates.longitude;
  	    console.log("log exact location: [" + this.DEFAULT_LAT + "," + this.DEFAULT_LONG  + "]");
        return this.coordinatesToCity(coordinates.latitude, coordinates.longitude)
          .then(city => {
            this.DEFAULT_CITY = city;
  		  console.log("calling from exact location subroutine");
  		  this.fetchAirMap();
          });
      }
	  else {
		console.log("Unrecognized permission.");
      	return Promise.reject(new Error('Unrecognized permission'));
	  }
  }
}

exports.flyDrone = functions.https.onRequest((req, res) => new FlyDrone(req, res).run());
