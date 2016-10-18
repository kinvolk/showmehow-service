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

function satisfied_external_event_output_with_largest_subset(satisfiedOutputs,
                                                             lessonSatisfiedStatus) {
    /* From here, if there is more than one event, we need
     * to figure out which one best covers the case we're after. This
     * means that it must subsume every other event.
     *
     * It should not be possible to have a situation where two events
     * are matched and there is not a single event which subsumes
     * them both. If this situation occurrs it is an error */
    satisfiedOutputs = satisfiedOutputs.filter(function(satisfiedOutputKey) {
        let satisfiedOutput = lessonSatisfiedStatus.outputs[satisfiedOutputKey];

        /* Check if all the other satisfied outputs are subsets of this
         * one. In the event that the subset of satisfied outputs is
         * empty after returning this one, then the result will still
         * be true, as [].every(w => false) is true. */
        return satisfiedOutputs.filter(key => key != satisfiedOutputKey).every(function(key) {
            return satisfiedOutput.subsumes.indexOf(key) !== -1;
        });
    });

    if (satisfiedOutputs.length === 1) {
        return {
            name: satisfiedOutputs[0],
            status: lessonSatisfiedStatus.outputs[satisfiedOutputs[0]]
        };
    }

    /* Error cases - no outputs satisfied or more than one output
     * satisfied. */
    let satisfiedEvents = Array.prototype.concat.apply([], satisfiedOutputs.map(function(output) {
        return lessonSatisfiedStatus.outputs[output].events;
    })).join(', ');

    if (satisfiedOutputs.length === 0) {
        throw new Error('No outputs were satisfied by events: ' +
                        satisfiedEvents + '. At any given point an ' +
                        'output must be satisfiable even if no ' +
                        'events occurr.');
    }

    throw new Error('More than one output (' +
                    satisfiedOutputs.join(', ') + ") was matched when " +
                    'following events were satisfied: ' + satisfiedEvents +
                    '. Only one output should be satisfiable. ' +
                    'Ensure that all outputs are expressed such that each event ' +
                    'is the perfect subset of another set of events in the subsumes ' +
                    'field.');
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

const _INPUT_SIDE_EFFECTS = {
    external_events: function(settings, service, lesson, task) {
        /* If we're already listening for events on this lesson and
         * task, clear the exsting structure and start over. */
        if ((service._pendingLessonEvents[lesson] || {})[task]) {
            delete service._pendingLessonEvents[lesson][task];
        }

        /* Mutate settings to get something close to what we want.
         * We abuse JSON.stringify here to get a deep copy. */
        let lessonSatisfiedStatus = {
            outputs: JSON.parse(JSON.stringify(settings))
        };
        let interestedInEvents = Object.keys(lessonSatisfiedStatus.outputs).map(function(key) {
            let outputSatisfied = lessonSatisfiedStatus.outputs[key];
            let outputSatisfiedEventStatus = {};

            /* Start tracking all these events */
            outputSatisfied.events.forEach(function(event) {
                return outputSatisfiedEventStatus[event] = false;
            });

            let interestingEvents = outputSatisfied.events;
            outputSatisfied.events = outputSatisfiedEventStatus;
            return interestingEvents;
        }).reduce(function(interestedInEvents, interestingEvents) {
            return addArrayUnique(interestedInEvents, interestingEvents);
        }, []);

        /* Use the settings to populate service._pendingLessonEvents
         * then emit a signal to other applications that we are listening
         * for certain events */
        service._pendingLessonEvents[lesson] = service._pendingLessonEvents[lesson] || {};
        service._pendingLessonEvents[lesson][task] = lessonSatisfiedStatus;

        /* Emit that we're interested in them */
        service.emit_listening_for_lesson_events(new GLib.Variant('a(s)',
                                                                  interestedInEvents.map((w) => [w])));
    }
};

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

    vfunc_handle_get_unlocked_lessons: function(method, client) {
        try {
            /* We call addArrayUnique here to ensure that showmehow is always in the
             * list, even if the gsettings key messes up and gets reset to an
             * empty list. */
            let unlocked = addArrayUnique(this._settings.get_strv('unlocked-lessons'), [
                'showmehow',
                'intro'
            ]).map(l => {
                return lessonDescriptorMatching(l, this._descriptors);
            }).filter(d => {
                return d && d.available_to.indexOf(client) !== -1;
            }).map(d => [d.name, d.desc, d.entry]);

            this.complete_get_unlocked_lessons(method, GLib.Variant.new('a(sss)', unlocked));
        } catch (e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    vfunc_handle_get_known_spells: function(method, client) {
        try {
            /* Get all the lesson details for the 'known' spells, eg, the ones the
             * user has already completed.
             */
            let ret = this._settings.get_strv('known-spells').map(l => {
                return lessonDescriptorMatching(l, this._descriptors);
            }).filter(d => {
                return d && d.available_to.indexOf(client) !== -1;
            }).map(d => [d.name, d.desc, d.entry]);
            this.complete_get_known_spells(method, GLib.Variant.new('a(sss)', ret));
        } catch (e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    vfunc_handle_get_task_description: function(method, lesson, task) {
        try {
            /* Return the descriptions for this task
             *
             * Note that in the specification file we allow a shorthand
             * to just specify that we want textual input, since it is
             * a very common case. Detect that here and turn it into
             * a JSON object representation that consumers can understand.
             *
             * Also note that this function is not necessarily stateless. Getting
             * a task description might have side effects like starting the
             * process to listen for certain OS-level events.
             */
            this._validateAndFetchTask(lesson, task, method, Lang.bind(this, function(task_detail) {
                let input_spec;
                if (typeof task_detail.input === 'string') {
                    input_spec = {
                        type: task_detail.input,
                        settings: {
                        }
                    };
                } else if (typeof task_detail.input === 'object') {
                    input_spec = task_detail.input;
                } else {
                    method.return_error_literal(ShowmehowErrorDomain,
                                                ShowmehowErrors.INVALID_TASK_SPEC,
                                                'Can\'t have an input spec which ' +
                                                'isn\'t either an object or a ' +
                                                'string (error in processing ' +
                                                JSON.stringify(task_detail.input) +
                                                ')');
                }

                if (_INPUT_SIDE_EFFECTS[input_spec.type]) {
                    _INPUT_SIDE_EFFECTS[input_spec.type](input_spec.settings,
                                                         this,
                                                         lesson,
                                                         task);
                }

                this.complete_get_task_description(method,
                                                   GLib.Variant.new('(ss)',
                                                                    [task_detail.task,
                                                                     JSON.stringify(input_spec)]));
            }));
        } catch (e) {
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

                        /* Take the result and run it through 'effects' to
                         * determine what to do next.
                         */
                        if (Object.keys(task_detail.effects).indexOf(result) === -1) {
                            method.return_error_literal(ShowmehowErrorDomain,
                                                        ShowmehowErrors.INVALID_TASK_SPEC,
                                                        'Don\'t know how to handle response ' +
                                                        result + ' with effects ' +
                                                        JSON.stringify(task_detail.effects, null, 2));
                        } else {
                            let effect = task_detail.effects[result];
                            if (effect.reply) {
                                if (typeof effect.reply === 'string') {
                                    responses.push({
                                        type: 'scrolled',
                                        value: effect.reply
                                    });
                                } else if (typeof effect.reply === 'object') {
                                    responses.push(effect.reply);
                                } else {
                                    method.return_error_literal(ShowmehowErrorDomain,
                                                                ShowmehowErrors.INVALID_TASK_SPEC,
                                                                'Can\'t have an output spec which ' +
                                                                'isn\'t either an object or a ' +
                                                                'string (error in processing ' +
                                                                JSON.stringify(effect.reply) +
                                                                ')');
                                }
                            }

                            if (effect.side_effects) {
                                effect.side_effects.map(Lang.bind(this, function(side_effect) {
                                    switch (side_effect.type) {
                                    case 'shell':
                                        shell_executor(side_effect.value);
                                        break;
                                    case 'unlock':
                                        {
                                            /* Get all unlocked tasks and this task's unlocks value and
                                             * combine the two together into a single set */
                                            let unlocked = this._settings.get_strv('unlocked-lessons');
                                            this._settings.set_strv('unlocked-lessons', addArrayUnique(unlocked, side_effect.value));
                                        }
                                        break;
                                    default:
                                        method.return_error_literal(ShowmehowErrorDomain,
                                                                    ShowmehowErrors.INVALID_TASK_SPEC,
                                                                    'Don\'t know how to handle side effect type ' +
                                                                    side_effect.type + ' in parsing (' +
                                                                    JSON.stringify(side_effect) + ')');
                                        break;
                                    }
                                }));
                            }

                            if (effect.completes_lesson) {
                                /* Add this lesson to the known-spells key */
                                let known = this._settings.get_strv('known-spells');
                                this._settings.set_strv('known-spells',
                                                        addArrayUnique(known, [lesson]));
                            }

                            let move_to = effect.move_to || (effect.completes_lesson ? '' : task);

                            /* If we are going to move to a different task to this one, clear any
                             * pending events for this lesson */
                            if (move_to !== task &&
                                (this._pendingLessonEvents[lesson] || {})[task]) {
                                delete this._pendingLessonEvents[lesson][task];
                            }

                            this.complete_attempt_lesson_remote(method,
                                                                new GLib.Variant('(ss)',
                                                                                 [JSON.stringify(responses),
                                                                                  move_to]));
                        }
                    }));
                }));
            }));
        } catch (e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    vfunc_handle_lesson_event: function(method, name) {
        Object.keys(this._pendingLessonEvents).forEach(Lang.bind(this, function(lesson) {
            Object.keys(this._pendingLessonEvents[lesson]).forEach(Lang.bind(this, function(task) {
                let lessonSatisfiedStatus = this._pendingLessonEvents[lesson][task];
                let satisfiedOutputs = Object.keys(lessonSatisfiedStatus.outputs).filter(function(key) {
                    /* Return true if every event was satisfied
                     *
                     * Note that unlike above, we are
                     * modifying spec.events inside of the filter
                     * function, such that the filter will pass
                     * if the event occurred. This means that in
                     * some cases, there will be multiple signals
                     * emitted if an output was satisfied and
                     * not acted upon yet */
                    let spec = lessonSatisfiedStatus.outputs[key];
                    return Object.keys(spec.events).every(function(key) {
                        spec.events[key] = (spec.events[key] || key == name);
                        return spec.events[key];
                    });
                });

                let satisfiedOutput = satisfied_external_event_output_with_largest_subset(satisfiedOutputs,
                                                                                          lessonSatisfiedStatus);
                if (satisfiedOutput.status.notify) {
                    this.emit_lesson_events_satisfied(lesson, task);
                }
            }));
        }));
    },

    vfunc_handle_register_clue: function(method, type, clue) {
        try {
            this._registerClue(type, clue);
            this.complete_register_clue(method);
        } catch (e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INVALID_CLUE_TYPE,
                                        String(e));
            log(String(e));
            log(String(e.stack));
        }

        return true;
    },

    vfunc_handle_get_clues: function(method) {
        try {
            this.complete_get_clues(method, this._settings.get_value('clues'));
        } catch (e) {
            method.return_error_literal(ShowmehowErrorDomain,
                                        ShowmehowErrors.INTERNAL_ERROR,
                                        String(e));
        }

        return true;
    },

    vfunc_handle_set_background: function(method, uri) {
        let command = "gsettings set org.gnome.desktop.background picture-uri " + uri
        try {
            shell_executor(command);
        } catch (e) {
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
    },

    _registerClue: function(type, content) {
        if (KNOWN_CLUE_TYPES.indexOf(type) === -1) {
            throw new Error('Tried to register clue of type ' + type + " but " +
                            'the service does not know how to handle that type. ' +
                            'Known clue types are ' + KNOWN_CLUE_TYPES.join(" "));
        }

        let clues = this._settings.get_value('clues').deep_unpack();
        clues = addArrayUnique(clues, [[content, type]], function(v, array) {
            return array.filter(function(existingClue) {
                return existingClue[0] == v[0] &&
                       existingClue[1] == v[1];
            }).length === 0;
        });
        this._settings.set_value('clues', GLib.Variant.new("a(ss)", clues));
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
