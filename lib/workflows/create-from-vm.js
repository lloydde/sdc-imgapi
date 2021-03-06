/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * A workflow to create an image from a VM.
 */


// This is not really needed, but javascriptlint will complain otherwise:
var sdcClients = require('sdc-clients');
var restify = require('restify');
var imgapiUrl, vmapiUrl, cnapiUrl;

var VERSION = '7.0.4';


function setErrorObject(err, job, cb) {
    var errInfo;
    if (err.message && err.message[0] === '{') {
        try {
            errInfo = JSON.parse(err.message);
        } catch (e) {}
    }

    if (errInfo) {
        job.error = errInfo;
    } else {
        // For both (a) sanity and (b) working around CAPI-337, let's limit the
        // "error.message" string to well under the 64k limit. Even with 50k I
        // hit problems with not being able to retrieve that node from UFDS.
        var errmsg = String(err);
        var LIMIT = 20000;
        if (errmsg.length > LIMIT) {
            var elide = '\n... content elided (full message was ' +
                String(errmsg.length) + ' characters) ...\n';
            var front = Math.floor((LIMIT - elide.length) / 2);
            var back = LIMIT - front - elide.length;
            errmsg = errmsg.slice(0, front) + elide + errmsg.slice(-back);
        }
        var error = { message: errmsg };

        if (err.code || err.restCode) {
            error.code = err.code || err.restCode;
        }
        job.error = error;
    }

    cb(err);
}


function getVmServer(job, cb) {
    var vmapi = new sdcClients.VMAPI({ url: vmapiUrl });

    vmapi.getVm({ uuid: job.params['vm_uuid'] }, function (err, vm, req, res) {
        if (err) {
            cb(err);
        } else {
            job.params['server_uuid'] = vm['server_uuid'];
            cb(null, 'Got VM server');
        }
        return;
    });
}


function queueCreateFromVmTask(job, cb) {
    var cnapi = restify.createJsonClient({ url: cnapiUrl });

    var payload = {
        jobid: job.uuid,
        compression: job.params.compression,
        imgapi_url: imgapiUrl,
        incremental: job.params.incremental,
        manifest: job.params.manifest,
        prepare_image_script: job.params.prepare_image_script,
        max_origin_depth: job.params.max_origin_depth
    };
    var path = '/servers/' + job.params['server_uuid'] +
                '/vms/' + job.params['vm_uuid'] + '/images';
    cnapi.post(path, payload, function (err, req, res, task) {
        if (err) {
            cb(err);
        } else {
            job.log.info('Payload passed to CNAPI %j', payload);
            job.taskId = task.id;
            cb(null, 'Task queued to CNAPI');
        }
        return;
    });
}


function pollTask(job, cb) {
    var cnapi = new sdcClients.CNAPI({ url: cnapiUrl });

    // We have to poll the task until it completes. Ensure the timeout is
    // big enough so tasks end on time
    var intervalId = setInterval(interval, 1000);

    function interval() {
        function onCnapi(err, task) {
            if (err) {
                cb(err);
            } else {
                if (task.status == 'failure') {
                    clearInterval(intervalId);
                    cb(errFromCnapiTask(task));

                } else if (task.status == 'complete') {
                    clearInterval(intervalId);
                    // After the provision succeeds it's up to the operator to
                    // check if the timeout is something that went wrong after
                    // the fact (heartbeater, fwapi issues). In this case we
                    // don't want to clean up NICs and UFDS usage because the
                    // VM was already physically created
                    job.cleanupOnTimeout = false;
                    cb(null, 'CNAPI task succeeded');
                }
            }
        }

        cnapi.getTask(job.taskId, onCnapi);
    }

    function errFromCnapiTask(task) {
        var message;
        var details = [];

        if (task.history !== undefined && task.history.length) {
            for (var i = 0; i < task.history.length; i++) {
                var event = task.history[i];
                if (event.name && event.name === 'error' && event.event &&
                    event.event.error) {
                    message = event.event.error;
                } else if (event.name && event.name === 'finish' &&
                    event.event && event.event.log && event.event.log.length) {
                    for (var j = 0; j < event.event.log.length; j++) {
                        var logEvent = event.event.log[j];
                        if (logEvent.level && logEvent.level === 'error') {
                            details.push(logEvent.message);
                        }
                    }
                }
            }
        }

        // Apparently the task doesn't have any message for us...
        if (message === undefined) {
            message = 'Unexpected error occured';
        } else if (details.length) {
            message += ': ' + details.join(', ');
        }

        return new Error(message);
    }
}


function updateWithError(job, cb) {
    if (job.error === undefined) {
        return cb(null, 'Job error object was not passed');
    }

    var imgapi = new sdcClients.IMGAPI({ url: imgapiUrl });
    var image = job.params.manifest.uuid;

    var mod = {
        state: 'failed',
        error: {
            message: job.error.message,
            code: job.error.code,
            stack: job.error.stack
        }
    };

    imgapi.updateImage(image, mod, function (err, img, res) {
        if (err) {
            return cb(err, 'Could not update image with publishing error');
        }

        return cb(null, 'Image updated with publishing error');
    });
}


var workflow = module.exports = {
    name: 'create-from-vm-' + VERSION,
    version: VERSION,
    chain: [ {
        name: 'vmapi.get_vm_server',
        timeout: 10,
        retry: 1,
        body: getVmServer,
        modules: { sdcClients: 'sdc-clients' },
        fallback: setErrorObject
    }, {
        name: 'cnapi.queue_create_from_vm_task',
        timeout: 10,
        retry: 1,
        body: queueCreateFromVmTask,
        modules: { restify: 'restify' },
        fallback: setErrorObject
    }, {
        name: 'cnapi.poll_task',
        timeout: 3600,
        retry: 1,
        body: pollTask,
        modules: { sdcClients: 'sdc-clients' },
        fallback: setErrorObject
    }],
    timeout: 3630,
    onerror: [ {
        name: 'update_with_error',
        body: updateWithError,
        modules: { sdcClients: 'sdc-clients' }
    }, {
        name: 'On error',
        modules: {},
        body: function (job, cb) {
            return cb('Error executing job');
        }
    }]
};
