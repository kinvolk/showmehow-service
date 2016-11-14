#!/usr/bin/env gjs
/* showmehow-service.js
 *
 * Copyright (c) 2016 Endless Mobile Inc.
 * All Rights Reserved.
 *
 * The Showmehow service is the central place where all 'lessons' about
 * the operating system are stored and progress is kept.
 */


const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Showmehow = imports.gi.Showmehow;

/* This is a hack to cause Showmehow js resources to get loaded */
const ShowmehowResource = imports.gi.Showmehow.get_resource();  // eslint-disable-line no-unused-vars

const Lang = imports.lang;

/* Put ourself in the search path. Note that we have the least priority.
 * This will allow us to run locally against non-packed files that
 * are already on disk if the user sets GJS_PATH appropriately. */
imports.searchPath.push('resource:///com/endlessm/showmehow');

const Validation = imports.lib.validation;
const Config = imports.lib.config;

const SHOWMEHOW_SCHEMA = 'com.endlessm.showmehow';

function environment_object_to_envp(environment) {
    if (environment) {
        return Object.keys(environment)
                     .map(key => key + '=' + environment[key]);
    } else {
        return null;
    }
}

function environment_as_object() {
    let environment = {};
    GLib.listenv().forEach(key => environment[key] = GLib.getenv(key));
    return environment;
}

function execute_command_for_output(argv, user_environment={}) {
    let environment = environment_as_object();
    Object.keys(user_environment).forEach(key => {
        environment[key] = user_environment[key];
    });

    let [ok, stdout, stderr, status] = GLib.spawn_sync(null,
                                                       argv,
                                                       environment_object_to_envp(environment),
                                                       0,
                                                       null);

    if (!ok) {
        GLib.spawn_check_exit_status(status);
        throw new Error('Failed to execute: ' + argv.join(" ") + ", no error " +
                        'message was set');
    }

    return {
        status: status,
        stdout: String(stdout),
        stderr: String(stderr)
    };
}

function select_random_from(array) {
    return array[Math.floor(Math.random() * array.length)];
}

const WAIT_MESSAGES = [
    'Wait for it',
    'Combubulating transistors',
    'Adjusting for combinatorial flux',
    'Hacking the matrix',
    'Exchanging electrical bits',
    'Refuelling source code',
    'Fetching arbitrary refs',
    'Resolving mathematical contradictions',
    'Fluxing liquid input'
];

function regex_validator(input, regex) {
    /* Case insensitive and multi-line */
    if (input.match(new RegExp(regex, 'mi')) !== null) {
        return ['success', []];
    }

    return ['failure', []];
}

/* Executing raw shellcode. What could possibly go wrong? */
function shell_executor(shellcode, environment) {
    if (!environment)
        environment = environment_as_object();
    if (Object.keys(environment).indexOf('CODING_FILES_DIR') === -1)
        environment.CODING_FILES_DIR = Config.coding_files_dir;
    if (Object.keys(environment).indexOf('CODING_SHARED_SCRIPT_DIR') === -1)
        environment.CODING_SHARED_SCRIPT_DIR = Config.coding_shared_script_dir;
    return execute_command_for_output(['/bin/bash', "-c", shellcode + "; exit 0"],
                                      environment);
}

function shell_executor_output(shellcode, settings) {
    let result = shell_executor(shellcode,
                                settings ? settings.environment : {});
    return [result.stdout + '\n' + result.stderr, []];
}

function shell_custom_executor_output(shellcode, settings) {
    if (typeof settings.command !== 'string') {
        throw new Error('shell_custom_executor_output: settings.command ' +
                        'must be a string. settings is ' +
                        JSON.stringify(settings, null, 2));
    }
    return shell_executor_output(settings.command, settings);
}

function add_wrapped_output(input) {
    return [input, [
        {
            type: 'response',
            content: {
                'type': "wrapped",
                'value': input
            }
        }
    ]];
}

function add_wait_message(input) {
    return [input, [
        {
            type: 'response',
            content: {
                'type': "scroll_wait",
                value: select_random_from(WAIT_MESSAGES)
            }
        }
    ]];
}


/**
 * addArrayUnique:
 *
 * Given some array, add another array and ensure
 * that all elements are unique.
 *
 * Provide the third 'arraySearch' argument if you
 * need to provide a custom function to search
 * the existing array for the value that
 * is being added.
 */
function addArrayUnique(lhs, rhs, arraySearchArg) {
    let arraySearch = arraySearchArg || ((c, p) => p.indexOf(c) === -1);
    return lhs.concat(rhs).reduce((p, c) => {
        if (arraySearch(c, p)) {
            p.push(c);
        }
        return p;
    }, []);
}

/**
 * lessonDescriptorMatching:
 *
 * Given a lesson name and lesson descriptors, return
 * the lesson descriptor.
 */
function lessonDescriptorMatching(lesson, descriptors) {
    /* An immediately invoked function expression to extract the relevant
     * useful information from a lesson descriptor without extracting
     * everything all at once. */
    let matches = descriptors.filter(d => d.name === lesson);

    if (matches.length !== 1) {
        log('Expected only a single match from ' + lesson +
            ' but there were ' + matches.length + " matches");
        return null;
    }

    return matches[0];
}

/**
 * loadLessonDescriptorsFromFile
 *
 * Given a GFile, load and validate lesson descriptors from it. Returns
 * the descriptors and warnings as a tuple.
 */
function loadLessonDescriptorsFromFile(file) {
    let warnings = [];
    let descriptors = null;
    let success = false;

    try {
        let contents = file.load_contents(null)[1];
        [descriptors, warnings] = Validation.validateDescriptors(JSON.parse(contents));
        success = true;
    } catch (e) {
        warnings.push('Unable to load ' + file.get_parse_name() + ": " + String(e));
    }

    return [success ? descriptors : null, warnings];
}

/**
 * loadLessonDescriptors
 *
 * Attempts to load lesson descriptors from a file.
 *
 * The default case is to load the descriptors from the internal resource
 * file that makes up Showmehow's binary. However, we first:
 *  1. Look at the command line to see if a file was provided there
 *  2. Look in $XDG_CONFIG_HOME for a file called 'lessons.json'
 *  3. Use the internal resource named 'data/lessons.json'
 *
 * The first two are assumed to be 'untrusted' - they will be validated
 * before being loaded in. If there are any errors, we try to use
 * what we can, but will add in an 'errors' entry to signify that
 * there were some errors that should be dealt with. Client applications
 * may query for errors and display them appropriately. This is
 * to help the lesson authors quickly catch problems.
 *
 * Returns a tuple of [descriptors, monitor]. The monitor may
 * hold a reference to a GFileMonitor or null, which needs to
 * be kept in scope to watch for changes to files.
 */
function loadLessonDescriptors(cmdlineFilename) {
    let filenamesToTry = [
        cmdlineFilename,
        GLib.build_pathv('/', [GLib.get_user_config_dir(), "showmehow", "lessons.json"])
    ].filter(f => !!f);

    var warnings = [];
    var descriptors = null;
    let monitor = null;

    /* Here we use a 'dumb' for loop, since we need to update
     * warnings if a filename didn't exist */
    for (let i = 0; i < filenamesToTry.length; ++i) {
        let file = Gio.File.new_for_path(filenamesToTry[i]);
        let loadWarnings;

        [descriptors, loadWarnings] = loadLessonDescriptorsFromFile(file);

        /* Concat the warnings anyway even if we weren't successful, since
         * the developer might still be interested in them. */
        warnings = warnings.concat(loadWarnings);

        /* If we were successful, then break here, otherwise try and load
         * the next file.
         *
         * Note that success is defined as 'we were able to partially load
         * a file.' */
        if (descriptors) {
            monitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
            break;
        }
    }

    /* If we don't have a file to work with here, go with the resources
     * path, but assume that it is trusted.
     *
     * This isn't the preferable way of doing it, though it seems like resource
     * paths are not working, at least not locally */
    if (!descriptors) {
        descriptors = JSON.parse(Gio.resources_lookup_data('/com/endlessm/showmehow/data/lessons.json',
                                                           Gio.ResourceLookupFlags.NONE).get_data());
    }

    /* Add a 'warnings' key to descriptors. */
    descriptors.warnings = warnings;
    return [descriptors, monitor];
}

const KNOWN_CLUE_TYPES = [
    'text',
    'image-path'
];

const _PIPELINE_FUNCS = {
    regex: regex_validator,
    shell: shell_executor_output,
    shell_custom: shell_custom_executor_output,
    input: function(input) { return [input, []]; },
    wait_message: add_wait_message,
    wrapped_output: add_wrapped_output
};


function _run_pipeline_step(pipeline, index, input, extras, done) {
    if (index === pipeline.length) {
        return done(input, extras);
    }

    let [output, funcExtras] = pipeline[index](input);
    return _run_pipeline_step(pipeline,
                              index + 1,
                              output,
                              extras.concat(funcExtras),
                              done);
}

function run_pipeline(pipeline, input, done) {
    return _run_pipeline_step(pipeline, 0, input, [], done);
}

const _CUSTOM_PIPELINE_CONSTRUCTORS = {
    check_external_events: function(service, lesson, task) {
        let lessonSatisfiedStatus = service._pendingLessonEvents[lesson][task];
        return function() {
            /* We need to figure out which output to map to here. It should
             * not be possible for a given set of inputs to match two outputs,
             * - one should always be a subset of another */
            let satisfiedOutputs = Object.keys(lessonSatisfiedStatus.outputs).filter(function(key) {
                /* Return true if every event was satisfied */
                let spec = lessonSatisfiedStatus.outputs[key];
                return Object.keys(spec.events).every(function(key) {
                    spec.events[key] = spec.events[key];
                    return spec.events[key];
                });
            });

            let event = satisfied_external_event_output_with_largest_subset(satisfiedOutputs,
                                                                              lessonSatisfiedStatus);
            return [event.name, []];
        };
    }
};

function mapper_to_pipeline_step(mapper, service, lesson, task) {
    let invalid = (!mapper ||
                   Object.keys(mapper).length !== 2 ||
                   mapper.type === undefined ||
                   mapper.value === undefined);

    if (invalid) {
        throw new Error('Invalid mapper definition (' +
                        JSON.stringify(mapper, null, 2) + ')');
    }

    if (_CUSTOM_PIPELINE_CONSTRUCTORS[mapper.type]) {
        return _CUSTOM_PIPELINE_CONSTRUCTORS[mapper.type](service, lesson, task);
    }

    return function(input) {
        return _PIPELINE_FUNCS[mapper.type](input, mapper.value);
    };
}


const ShowmehowErrorDomain = GLib.quark_from_string('showmehow-error');
const ShowmehowErrors = {
    INVALID_TASK: 0,
    INVALID_TASK_SPEC: 1,
    INVALID_CLUE_TYPE: 2,
    INTERNAL_ERROR: 3
};
const ShowmehowService = new Lang.Class({
    Name: 'ShowmehowService',
    Extends: Showmehow.ServiceSkeleton,

    _init: function(props, descriptors, monitor) {
        this.parent(props);
        this._settings = new Gio.Settings({ schema_id: SHOWMEHOW_SCHEMA });
        this._descriptors = descriptors;
        this._monitor = monitor;
        this._pendingLessonEvents = {};

        /* Log the warnings, and also make them available to clients who are interested.
         *
         * XXX: For some odd reason, I'm not able to return 'as" here and need to
         * return an array of structures in order to get this to work. */
        this._descriptors.warnings.forEach(w => log(w));

        /* If we did have a monitor on the file, it means that we can notify clients
         * when a reload has happened. To do that, connect to the 'changed' signal
         * and emit the 'content-refreshed' signal when a change happens. Clients
         * should reset their internal state when this happens. */
        if (this._monitor) {
            this._monitor.connect('changed', Lang.bind(this, function(monitor, file, other, type) {
                if (type === Gio.FileMonitorEvent.CHANGED) {
                    let [descriptors, warnings] = loadLessonDescriptorsFromFile(file);

                    if (descriptors) {
                        this._descriptors = descriptors;
                        this._descriptors.warnings = warnings;

                        this.emit_lessons_changed();
                    }
                }
            }));
        }
    },

    vfunc_handle_get_warnings: function(method) {
        try {
            this.complete_get_warnings(method, GLib.Variant.new('a(s)',
                                                                this._descriptors.warnings.map((w) => [w])));
        } catch(e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    vfunc_handle_attempt_lesson_remote: function(method, lesson, task, input_code) {
        try {
            this._validateAndFetchTask(lesson, task, method, Lang.bind(this, function(task_detail) {
                let mapper = task_detail.mapper;
                this._withPipeline(mapper, lesson, task, method, Lang.bind(this, function(pipeline) {
                    /* Run each step in the pipeline over the input and
                     * get a result code at the end. Each step should
                     * pass a string to the next function. */
                    run_pipeline(pipeline, input_code, Lang.bind(this, function(result, extras) {
                        /* Start to build up the response based on what is in extras */
                        let responses = extras.filter(function(extra) {
                            return extra.type === 'response';
                        }).map(function(extra) {
                            return extra.content;
                        });

                        let returnValue = {
                            result: result,
                            responses: responses
                        };

                        let serialized = JSON.stringify(returnValue);
                        this.complete_attempt_lesson_remote(method, serialized);
                    }));
                }));
            }));
        } catch (e) {
            logError(e, 'Internal error in handle_lesson_response');
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    _validateAndFetchTask: function(lesson, task, method, success) {
        let task_detail;

        try {
            let lesson_detail = this._descriptors.filter(d => {
                return d.name === lesson;
            })[0];
            let task_detail_key = Object.keys(lesson_detail.practice).filter(k => {
                return k === task;
            })[0];
            task_detail = lesson_detail.practice[task_detail_key];
        } catch(e) {
            return method.return_error_literal(ShowmehowErrorDomain,
                                               ShowmehowErrors.INVALID_TASK,
                                               'Either the lesson ' + lesson +
                                               ' or task id ' + task +
                                               ' was invalid\n' + e + " " + e.stack);
        }

        return success(task_detail);
    },

    _withPipeline: function(mappers, lesson, task, method, callback) {
        /* This function finds the executor and validator specified
         * and runs callback. If it can't find them, for instance, they
         * are invalid, it returns an error. */
        let pipeline = null;
        try {
            pipeline = mappers.map(Lang.bind(this, function(mapper) {
                if (typeof mapper === 'string') {
                    return mapper_to_pipeline_step({
                        type: mapper,
                        value: null
                    }, this, lesson, task);
                } else if (typeof mapper === 'object') {
                    return mapper_to_pipeline_step(mapper, this, lesson, task);
                }

                throw new Error('mapper must be a either a string or ' +
                                'or an object, got ' + JSON.stringify(mapper));
            }));
        } catch (e) {
            return method.return_error_literal(ShowmehowErrorDomain,
                                               ShowmehowErrors.INVALID_TASK_SPEC,
                                               'Couldn\'t run task ' + task +
                                               ' on lesson ' + lesson + ': ' +
                                               'Couldn\'t create pipeline: ' +
                                               String(e) + e.stack);
        }

        return callback(pipeline);
    }
});

/**
 * parseArguments
 *
 * Sadly, GOptionEntry is not supported by Gjs, so this is a poor-man's
 * option parser.
 *
 * This option parser is a simple 'state machine' option parser. It just
 * has a state as to whether it is parsing a double-dash option, or
 * if it is parsing something else. There is no type checking or
 * validation.
 *
 * Sadly, this means that there is no way to add arguments to --help
 * to show the user.
 *
 * Everything is stored as an array.
 */
function parseArguments(argv) {
    var parsing = null;
    var options = {};

    argv.forEach(function(arg, i) {
        let isDoubleDash = arg.startsWith('--');
        if (isDoubleDash) {
            parsing = arg.slice(2);
        }

        let key = parsing || arg;
        options[key] = options[key] || [];

        /* Whether we push arg to the options
         * list depends on what is ahead of us.
         *
         * If this was a double-dash argument
         * then check if the next argument
         * starts with something that is
         * not a double dash. If so, we should
         * treat this argument as a key and
         * not a value, otherwise treat it
         * truthy value.
         */
        if (!isDoubleDash ||
            i === argv.length - 1 ||
            argv[i + 1].startsWith('--')) {
            options[key].push(isDoubleDash ? !!arg : arg);
        }
    });

    return options;
}

const ShowmehowServiceApplication = new Lang.Class({
    Name: 'ShowmehowServiceApplication',
    Extends: Gio.Application,

    _init: function(params) {
        this.parent(params);
        this._skeleton = null;
        this._commandLineFilename = null;
    },

    vfunc_startup: function() {
        this.parent();
        this.hold();
    },

    vfunc_handle_local_options: function(options) {
        this.parent(options);

        /* For some rather daft reasons, we have to parse ARGV
         * directly to find out some interesting things. */
        let parsed = parseArguments(ARGV);
        try {
            this._commandLineFilename = parsed['lessons-file'][0];
        } catch (e) {
            this._commandLineFilename = null;
        }

        /* Must return -1 here to continue processing, otherwise
         * we will exit with a code */
        return -1;
    },

    vfunc_dbus_register: function(conn, object_path) {
        this.parent(conn, object_path);
        let [descriptors, monitor] = loadLessonDescriptors(this._commandLineFilename);
        this._skeleton = new ShowmehowService({}, descriptors, monitor);
        this._skeleton.export(conn, object_path);
        return true;
    },

    vfunc_dbus_unregister: function(conn, object_path) {
        if (this._skeleton) {
            this._skeleton.unexport();
        }

        this.parent(conn, object_path);
    }
});

let application = new ShowmehowServiceApplication({
    'application-id': 'com.endlessm.Showmehow.Service',
    'flags': Gio.ApplicationFlags.IS_SERVICE |
             Gio.ApplicationFlags.HANDLES_COMMAND_LINE
});
application.run(ARGV);
