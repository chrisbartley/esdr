var trimAndCopyPropertyIfNonEmpty = require('../lib/objectUtils').trimAndCopyPropertyIfNonEmpty;
var JaySchema = require('jayschema');
var jsonValidator = new JaySchema();
var ValidationError = require('../lib/errors').ValidationError;
var Query2Query = require('query2query');
var util = require('util');
var JSendClientError = require('jsend-utils').JSendClientError;
var httpStatus = require('http-status');
var flow = require('nimble');
var log = require('log4js').getLogger('esdr:models:devices');

var CREATE_TABLE_QUERY = " CREATE TABLE IF NOT EXISTS `Devices` ( " +
                         "`id` bigint(20) NOT NULL AUTO_INCREMENT, " +
                         "`name` varchar(255) DEFAULT NULL, " +
                         "`serialNumber` varchar(255) NOT NULL, " +
                         "`productId` bigint(20) NOT NULL, " +
                         "`userId` bigint(20) NOT NULL, " +
                         "`created` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
                         "`modified` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, " +
                         "PRIMARY KEY (`id`), " +
                         "UNIQUE KEY `serialNumber_productId_userId_index` (`serialNumber`,`productId`,`userId`), " +
                         "KEY `name` (`name`), " +
                         "KEY `serialNumber` (`serialNumber`), " +
                         "KEY `productId` (`productId`), " +
                         "KEY `userId` (`userId`), " +
                         "KEY `created` (`created`), " +
                         "KEY `modified` (`modified`), " +
                         "CONSTRAINT `devices_productId_fk_1` FOREIGN KEY (`productId`) REFERENCES `Products` (`id`), " +
                         "CONSTRAINT `devices_userId_fk_1` FOREIGN KEY (`userId`) REFERENCES `Users` (`id`) " +
                         ") ENGINE=InnoDB AUTO_INCREMENT=1 DEFAULT CHARSET=utf8";

var MAX_FOUND_DEVICES = 100;

var query2query = new Query2Query();
query2query.addField('id', true, true, false, Query2Query.types.INTEGER);
query2query.addField('name', true, true, true);
query2query.addField('serialNumber', true, true, false);
query2query.addField('productId', true, true, false, Query2Query.types.INTEGER);
query2query.addField('userId', false, false, false, Query2Query.types.INTEGER);
query2query.addField('created', true, true, false, Query2Query.types.DATETIME);
query2query.addField('modified', true, true, false, Query2Query.types.DATETIME);

var JSON_SCHEMA = {
   "$schema" : "http://json-schema.org/draft-04/schema#",
   "title" : "Device",
   "description" : "An ESDR device",
   "type" : "object",
   "properties" : {
      "name" : {
         "type" : "string",
         "minLength" : 0,
         "maxLength" : 255
      },
      "serialNumber" : {
         "type" : "string",
         "pattern" : "^[a-zA-Z0-9_\\+\\-\\,\\:]+$",   // alphanumeric and _ + - , :
         "minLength" : 1,
         "maxLength" : 255
      }
   },
   "required" : ["serialNumber"]
};

module.exports = function(databaseHelper) {
   var self = this;

   this.jsonSchema = JSON_SCHEMA;

   this.initialize = function(callback) {
      databaseHelper.execute(CREATE_TABLE_QUERY, [], function(err) {
         if (err) {
            log.error("Error trying to create the Devices table: " + err);
            return callback(err);
         }

         return callback(null, true);
      });
   };

   this.create = function(deviceDetails, productId, userId, callback) {
      // first build a copy and trim some fields
      var device = {
         productId : productId,
         userId : userId
      };
      trimAndCopyPropertyIfNonEmpty(deviceDetails, device, "name");
      trimAndCopyPropertyIfNonEmpty(deviceDetails, device, "serialNumber");

      // now validate
      jsonValidator.validate(device, JSON_SCHEMA, function(err1) {
         if (err1) {
            return callback(new ValidationError(err1));
         }

         // now that we have the hashed secret, try to insert
         databaseHelper.execute("INSERT INTO Devices SET ?", device, function(err2, result) {
            if (err2) {
               return callback(err2);
            }

            return callback(null, {
               insertId : result.insertId,
               // include these because they might have been modified by the trimming
               name : device.name,
               serialNumber : device.serialNumber
            });
         });
      });
   };

   this.deleteDevice = function(deviceId, userId, callback) {
      // We want to be able to return proper HTTP status codes for if the device doesn't exist (404), the device isn't owned
      // by the user (403), the device has existing feeds (409), or successful delete (200), etc.  So, we'll create a
      // transaction, try to find the device, manually check whether the device is owned by the user, and proceed with
      // the delete accordingly.

      var connection = null;
      var error = null;
      var hasError = function() {
         return error != null;
      };
      var isExistingDevice = false;
      var isDeviceOwnedByUser = false;
      var associatedFeeds = null;
      var deleteResult = null;
      var hasAssociatedFeeds = function() {
         return associatedFeeds != null && associatedFeeds.length > 0;
      };

      flow.series(
            [
               // get the connection
               function(done) {
                  log.debug("delete device [user " + userId + ", device " + deviceId + "]: 1) Getting the connection");
                  databaseHelper.getConnection(function(err, newConnection) {
                     if (err) {
                        error = err;
                     }
                     else {
                        connection = newConnection;
                     }
                     done();
                  });
               },

               // begin the transaction
               function(done) {
                  if (!hasError()) {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 2) Beginning the transaction");
                     connection.beginTransaction(function(err) {
                        if (err) {
                           error = err;
                        }
                        done();
                     });
                  }
                  else {
                     done();
                  }
               },

               // find the device
               function(done) {
                  if (!hasError()) {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 3) Find the device");
                     connection.query("SELECT userId FROM Devices WHERE id=?",
                                      [deviceId],
                                      function(err, rows) {
                                         if (err) {
                                            error = err;
                                         }
                                         else {
                                            // set flags for whether the device exists and is owned by the requesting user
                                            isExistingDevice = (rows && rows.length == 1);
                                            if (isExistingDevice) {
                                               isDeviceOwnedByUser = rows[0].userId === userId;
                                            }
                                         }
                                         done();
                                      });
                  }
                  else {
                     done();
                  }
               },

               // see whether the device has existing feeds
               function(done) {
                  if (!hasError() && isExistingDevice && isDeviceOwnedByUser) {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 4) See whether the device has associated feeds");
                     connection.query("SELECT id FROM Feeds WHERE deviceId=? ORDER BY id",
                                      [deviceId],
                                      function(err, rows) {
                                         if (err) {
                                            error = err;
                                         }
                                         else {
                                            // set flag for whether the device has associated feeds
                                            if (rows && rows.length > 0) {
                                               associatedFeeds = [];
                                               rows.forEach(function(row) {
                                                  associatedFeeds.push(row.id)
                                               });
                                            }
                                         }
                                         done();
                                      });
                  }
                  else {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 4) Delete skipped because device doesn't exist or not owned by user");
                     done();
                  }
               },

               // delete ONLY if there were no errors, the device exists, is owned by the user, and has no associated
               // feeds.   If so, start by deleting any device properties and then delete the device if no errors
               function(done) {
                  if (!hasError() && isExistingDevice && isDeviceOwnedByUser && !hasAssociatedFeeds()) {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 5) Delete the device properties (if any), then the device");
                     connection.query("DELETE FROM DeviceProperties where deviceId = ?",
                                      [deviceId],
                                      function(err) {
                                         if (err) {
                                            error = err;
                                         }
                                         else {
                                            connection.query("DELETE FROM Devices where id = ? AND userId = ?",
                                                             [deviceId, userId],
                                                             function(err) {
                                                                if (err) {
                                                                   error = err;
                                                                }
                                                                else {
                                                                   deleteResult = {
                                                                      id : deviceId
                                                                   };
                                                                }
                                                                done();
                                                             });
                                         }
                                      });
                  }
                  else {
                     log.debug("delete device [user " + userId + ", device " + deviceId + "]: 5) Delete skipped because device doesn't exist, is not owned by user, or it has existing feeds");
                     done();
                  }
               }
            ],

            // handle outcome
            function() {
               log.debug("delete device [user " + userId + ", device " + deviceId + "]: 6) All done, now checking status and performing commit/rollback as necessary!");
               if (hasError()) {
                  connection.rollback(function() {
                     connection.release();
                     log.error("delete device [user " + userId + ", device " + deviceId + "]: 7) An error occurred while deleting the device, rolled back the transaction. Error:" + error);
                     callback(error);
                  });
               }
               else if (deleteResult == null) {
                  connection.rollback(function() {
                     connection.release();
                     log.info("delete device [user " + userId + ", device " + deviceId + "]: 7) Device not deleted (exists=" + isExistingDevice + ", owned by user=" + isDeviceOwnedByUser + ", has feeds=" + hasAssociatedFeeds() + "), rolled back the transaction.");
                     if (isExistingDevice) {
                        if (isDeviceOwnedByUser) {
                           if (hasAssociatedFeeds()) {
                              return callback(new JSendClientError("Device cannot be deleted because it has dependent feeds", {
                                 id : deviceId,
                                 feedIds : associatedFeeds
                              }, httpStatus.CONFLICT));
                           }
                           else {
                              log.error("delete device [user " + userId + ", device " + deviceId + "]: 8) The deleteResult is null, but the device [" + deviceId + "] exists AND is owned by the user [" + userId + "]--this should NEVER happen!");
                              return callback(new JSendServerError("Internal Server Error"));
                           }
                        }
                        else {
                           return callback(new JSendClientError("Forbidden", { id : deviceId }, httpStatus.FORBIDDEN));
                        }
                     }
                     else {
                        return callback(new JSendClientError("Device not found", { id : deviceId }, httpStatus.NOT_FOUND));
                     }
                  });
               }
               else {
                  log.debug("delete device [user " + userId + ", device " + deviceId + "]: 7) Delete successful, attempting to commit the transaction...");
                  connection.commit(function(err) {
                     if (err) {
                        log.error("delete device [user " + userId + ", device " + deviceId + "]: 8) Failed to commit the transaction after deleting the device");

                        // rollback and then release the connection
                        connection.rollback(function() {
                           connection.release();
                           callback(err);
                        });
                     }
                     else {
                        connection.release();
                        log.debug("delete device [user " + userId + ", device " + deviceId + "]: 8) Commit successful!");

                        callback(null, deleteResult);
                     }
                  });
               }
            }
      );
   };

   /**
    * Tries to find the device with the given <code>deviceId</code> for the given authenticated user and returns it to
    * the given <code>callback</code>. If successful, the device is returned as the 2nd argument to the
    * <code>callback</code> function.  If unsuccessful, <code>null</code> is returned to the callback.
    *
    * @param {number} deviceId id of the device to find.
    * @param {string|array} fieldsToSelect comma-delimited string or array of strings of field names to select.
    * @param {number} authUserId id of the user requesting this device.
    * @param {function} callback function with signature <code>callback(err, device)</code>
    */
   this.findByIdForUser = function(deviceId, authUserId, fieldsToSelect, callback) {
      query2query.parse({ fields : fieldsToSelect }, function(err, queryParts) {
         if (err) {
            return callback(err);
         }

         var sql = "SELECT " + queryParts.select + ",userId FROM Devices WHERE id=?";
         databaseHelper.findOne(sql,
                                [deviceId],
                                function(err, device) {
                                   if (err) {
                                      return callback(err);
                                   }

                                   if (device) {
                                      // return an error if the user doesn't own this device
                                      if (device.userId != authUserId) {
                                         return callback(new JSendClientError("Access denied", null, httpStatus.FORBIDDEN));
                                      }

                                      // if the user didn't select the userId, don't return it to them
                                      if (queryParts.selectFields.indexOf('userId') < 0) {
                                         delete device.userId;
                                      }
                                   }

                                   return callback(null, device);
                                });
      });
   };

   /**
    * Tries to find the device with the given <code>productId</code> and <code>serialNumber</code> for the given user
    * and returns it to the given <code>callback</code>.  If successful, the device is returned in an array to the 2nd
    * argument to the <code>callback</code> function.  If unsuccessful, <code>null</code> is returned to the callback.
    *
    * @param {number} productId id of the product to find.
    * @param {number} serialNumber serial number of the device to find.
    * @param {number} userId id of the user owning this device.
    * @param {string|array} fieldsToSelect comma-delimited string or array of strings of field names to select.
    * @param {function} callback function with signature <code>callback(err, device)</code>
    */
   this.findByProductIdAndSerialNumberForUser = function(productId, serialNumber, userId, fieldsToSelect, callback) {
      query2query.parse({ fields : fieldsToSelect }, function(err, queryParts) {
         if (err) {
            return callback(err);
         }

         databaseHelper.findOne(queryParts.selectClause + " FROM Devices WHERE productId=? AND serialNumber=? AND userId=?",
                                [productId, serialNumber, userId],
                                callback);
      });
   };

   this.findForUser = function(userId, queryString, callback) {
      query2query.parse(queryString,
                        function(err, queryParts) {

                           if (err) {
                              return callback(err);
                           }

                           // We need to be really careful about security here!  Restrict the WHERE clause to allow returning
                           // only devices owned by the authenticated user.
                           var whereClause = "WHERE (userId = " + userId + ")";
                           if (queryParts.whereExpressions.length > 0) {
                              whereClause += " AND (" + queryParts.where + ")";
                           }

                           // build the restricted SQL query
                           var restrictedSql = [
                              queryParts.selectClause,
                              "FROM Devices",
                              whereClause,
                              queryParts.orderByClause,
                              queryParts.limitClause
                           ].join(' ');
                           log.debug("Devices.findForUser(): " + restrictedSql + (queryParts.whereValues.length > 0 ? " [where values: " + queryParts.whereValues + "]" : ""));

                           // use findWithLimit so we can also get a count of the total number of records that would have been returned
                           // had there been no LIMIT clause included in the query
                           databaseHelper.findWithLimit(restrictedSql, queryParts.whereValues, function(err, result) {
                              if (err) {
                                 return callback(err);
                              }

                              // copy in the offset and limit
                              result.offset = queryParts.offset;
                              result.limit = queryParts.limit;

                              return callback(null, result, queryParts.selectFields);
                           });
                        },
                        MAX_FOUND_DEVICES);
   };
};
