import { Selection } from 'prosemirror-state';
import { DOMParser, Schema, Slice, Node } from 'prosemirror-model';
import {
	compressSelectionJSON,
	uncompressSelectionJSON,
	uncompressStateJSON,
	uncompressStepJSON,
} from 'prosemirror-compress-pubpub';
import { Step, Mapping } from 'prosemirror-transform';
import { defaultNodes, defaultMarks } from './schemas';

export const docIsEmpty = (doc) => {
	return (
		doc.childCount === 0 ||
		(doc.childCount === 1 && doc.firstChild.isTextblock && doc.firstChild.content.size === 0)
	);
};

export const dispatchEmptyTransaction = (editorView) => {
	const emptyInitTransaction = editorView.state.tr;
	editorView.dispatch(emptyInitTransaction);
};

export const buildSchema = (customNodes = {}, customMarks = {}) => {
	const schemaNodes = {
		...defaultNodes,
		...customNodes,
	};
	const schemaMarks = {
		...defaultMarks,
		...customMarks,
	};

	/* Filter out undefined (e.g. overwritten) nodes and marks */
	Object.keys(schemaNodes).forEach((nodeKey) => {
		if (!schemaNodes[nodeKey]) {
			delete schemaNodes[nodeKey];
		}
	});
	Object.keys(schemaMarks).forEach((markKey) => {
		if (!schemaMarks[markKey]) {
			delete schemaMarks[markKey];
		}
	});

	return new Schema({
		nodes: schemaNodes,
		marks: schemaMarks,
		topNode: 'doc',
	});
};

export const renderStatic = (schema = buildSchema(), nodeArray, editorProps) => {
	return nodeArray.map((node, index) => {
		let children;
		if (node.content) {
			children = renderStatic(schema, node.content, editorProps);
		}
		if (node.type === 'text') {
			const marks = node.marks || [];
			children = marks.reduce((prev, curr) => {
				const MarkComponent = schema.marks[curr.type].spec.toStatic(curr, prev);
				return MarkComponent;
			}, node.text);
		}

		const nodeWithIndex = node;
		nodeWithIndex.currIndex = index;
		const nodeOptions = editorProps.nodeOptions || {};
		const customOptions = nodeOptions[node.type] || {};
		const mergedOptions = { ...schema.nodes[node.type].spec.defaultOptions, ...customOptions };
		const NodeComponent = schema.nodes[node.type].spec.toStatic(
			nodeWithIndex,
			mergedOptions,
			false,
			false,
			{ ...editorProps, renderStaticMarkup: true },
			children,
		);
		return NodeComponent;
	});
};

export const getJSON = (editorView) => {
	if (!editorView) {
		return null;
	}
	return editorView.state.doc.toJSON();
};

export const getText = (editorView, separator = '\n') => {
	if (!editorView) {
		return null;
	}
	return editorView.state.doc.textBetween(0, editorView.state.doc.nodeSize - 2, separator);
};

export const getCollabJSONs = (editorView, collabIds) => {
	const collabPlugin = editorView.state.plugins.reduce((prev, curr) => {
		if (curr.key === 'collaborative$') {
			return curr;
		}
		return prev;
	}, undefined);

	return collabPlugin ? collabPlugin.getJSONs(collabIds) : null;
};

export const importHtml = (editorView, htmlString) => {
	/* Create wrapper DOM node */
	const wrapperElem = document.createElement('div');

	/* Insert htmlString into wrapperElem to generate full DOM tree */
	wrapperElem.innerHTML = htmlString;

	/* Generate new ProseMirror doc from DOM node */
	const newDoc = DOMParser.fromSchema(editorView.state.schema).parse(wrapperElem);

	/* Create transaction and set selection to the beginning of the doc */
	const tr = editorView.state.tr;
	tr.setSelection(Selection.atStart(editorView.state.doc));
	tr.replaceSelection(new Slice(newDoc.content, 0, 0));

	/* Dispatch transaction to setSelection and insert content */
	editorView.dispatch(tr);
};

export const focus = (editorView) => {
	editorView.focus();
};

export const marksAtSelection = (editorView) => {
	return editorView.state.selection.$from.marks().map((mark) => {
		return mark.type.name;
	});
};

export const moveSelectionToStart = (editorView) => {
	/* Create transaction and set selection to the beginning of the doc */
	const tr = editorView.state.tr;
	tr.setSelection(Selection.atStart(editorView.state.doc));

	/* Dispatch transaction to setSelection and insert content */
	editorView.dispatch(tr);
};

export const moveSelectionToEnd = (editorView) => {
	/* Create transaction and set selection to the end of the doc */
	const tr = editorView.state.tr;
	tr.setSelection(Selection.atEnd(editorView.state.doc));

	/* Dispatch transaction to setSelection and insert content */
	editorView.dispatch(tr);
};

export const getFirebaseDoc = (firebaseRef, schema, versionNumber) => {
	let mostRecentRemoteKey;
	return firebaseRef
		.child('checkpoint')
		.once('value')
		.then((checkpointSnapshot) => {
			const emptyDoc = { type: 'doc', attrs: { meta: {} }, content: [{ type: 'paragraph' }] };
			const checkpointSnapshotVal = checkpointSnapshot.val() || {
				k: '0',
				d: emptyDoc,
			};

			/* If the given versionNumber is earlier than the checkpoint, build doc from 0 */
			if (versionNumber && versionNumber < Number(checkpointSnapshotVal.k)) {
				checkpointSnapshotVal.k = '0';
				checkpointSnapshotVal.d = emptyDoc;
			}

			mostRecentRemoteKey = Number(checkpointSnapshotVal.k);
			const newDoc = Node.fromJSON(
				schema,
				uncompressStateJSON({ d: checkpointSnapshotVal.d }).doc,
			);

			/* Get all changes since mostRecentRemoteKey */
			const getChanges = firebaseRef
				.child('changes')
				.orderByKey()
				.startAt(String(mostRecentRemoteKey + 1))
				.endAt(String(versionNumber))
				.once('value');

			return Promise.all([newDoc, getChanges]);
		})
		.then(([newDoc, changesSnapshot]) => {
			const changesSnapshotVal = changesSnapshot.val() || {};
			const steps = [];
			const stepClientIds = [];
			const keys = Object.keys(changesSnapshotVal);
			mostRecentRemoteKey = keys.length ? Math.max(...keys) : mostRecentRemoteKey;

			/* flattenedMergeStepArray is an array of { steps, client, time } values */
			/* It flattens the case where we have a merge-object which is an array of */
			/* { steps, client, time } values. */
			const flattenedMergeStepArray = Object.keys(changesSnapshotVal).reduce((prev, curr) => {
				if (Array.isArray(changesSnapshotVal[curr])) {
					return [...prev, ...changesSnapshotVal[curr]];
				}
				return [...prev, changesSnapshotVal[curr]];
			}, []);

			/* Uncompress steps and add stepClientIds */
			flattenedMergeStepArray.forEach((stepContent) => {
				const compressedStepsJSON = stepContent.s;
				const uncompressedSteps = compressedStepsJSON.map((compressedStepJSON) => {
					return Step.fromJSON(schema, uncompressStepJSON(compressedStepJSON));
				});
				steps.push(...uncompressedSteps);
				stepClientIds.push(...new Array(compressedStepsJSON.length).fill(stepContent.c));
			});
			/* Uncompress steps and add stepClientIds */
			// Object.keys(changesSnapshotVal).forEach((key) => {
			// 	console.log('isArray', Array.isArray(changesSnapshotVal[key]));
			// 	const compressedStepsJSON = changesSnapshotVal[key].s;
			// 	const uncompressedSteps = compressedStepsJSON.map((compressedStepJSON) => {
			// 		return Step.fromJSON(schema, uncompressStepJSON(compressedStepJSON));
			// 	});
			// 	steps.push(...uncompressedSteps);
			// 	stepClientIds.push(
			// 		...new Array(compressedStepsJSON.length).fill(changesSnapshotVal[key].c),
			// 	);
			// });
			const updatedDoc = steps.reduce((prev, curr) => {
				const stepResult = curr.apply(prev);
				if (stepResult.failed) {
					console.error('Failed with ', stepResult.failed);
				}
				return stepResult.doc;
			}, newDoc);
			return {
				content: updatedDoc.toJSON(),
				mostRecentRemoteKey: mostRecentRemoteKey,
			};
		})
		.catch((firebaseErr) => {
			console.error('firebaseErr', firebaseErr);
		});
};

export const generateHash = (length) => {
	const tokenLength = length || 32;
	const possible = 'abcdefghijklmnopqrstuvwxyz0123456789';

	let hash = '';
	for (let index = 0; index < tokenLength; index += 1) {
		hash += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return hash;
};

export const getDiscussionData = (editorView) => {
	const newSelection = compressSelectionJSON(editorView.state.selection.toJSON());
	const remoteKey = editorView.state.collaborative$.mostRecentRemoteKey;
	return {
		currentKey: remoteKey,
		initAnchor: newSelection.a,
		initHead: newSelection.h,
		initKey: remoteKey,
		selection: newSelection,
	};
};

export const restoreDiscussionMaps = (firebaseRef, schema, useMergeSteps) => {
	/* This function looks at all the discussions and ensures */
	/* they have been mapped through all necessary steps */

	/* Get all discussions and find the oldest currentKey we */
	/* must map from */
	return firebaseRef
		.child('discussions')
		.once('value')
		.then((discussionsSnapshot) => {
			const discussions = discussionsSnapshot.val();
			const earliestKey = Object.values(discussions).reduce((prev, curr) => {
				if (Number(curr.currentKey) < prev) {
					return curr.currentKey;
				}
				return prev;
			}, Infinity);
			return [discussions, earliestKey];
		})
		.then(([discussions, earliestKey]) => {
			const getNewSteps = firebaseRef
				.child('changes')
				.orderByKey()
				.startAt(String(earliestKey + 1))
				.once('value');
			const getNewMerges = useMergeSteps
				? firebaseRef
						.child('merges')
						.orderByKey()
						.startAt(String(earliestKey + 1))
						.once('value')
				: { val: () => ({}) };
			const getStarterContent = getFirebaseDoc(firebaseRef, schema, earliestKey);
			return Promise.all([
				discussions,
				earliestKey,
				getNewSteps,
				getNewMerges,
				getStarterContent,
			]);
		})
		.then(([discussions, earliestKey, newStepsSnapshot, newMergesSnapshot, starterContent]) => {
			const allChanges = {
				...newStepsSnapshot.val(),
				...newMergesSnapshot.val(),
			};
			/* Check if we are missing any keys - which can happen if steps */
			/* across a merge are needed, and we're calling from without */
			/* userMergeSteps (i.e. we're calling from clientside) */
			const isMissingKeys = Object.keys(allChanges)
				.sort()
				.reduce((prev, curr, index, array) => {
					const isLastElement = index === array.length - 1;
					const nextElement = array[index + 1];
					if (!isLastElement && Number(curr) + 1 !== Number(nextElement)) {
						return true;
					}
					return prev;
				}, false);
			if (!Object.keys(allChanges).length) {
				// console.log('Hey - nothing to do!');
				return null;
			}
			if (isMissingKeys) {
				console.error('Keys are missing so we cannot restore discussion maps.');
				return null;
			}
			const newDiscussions = {};
			let currentDoc = Node.fromJSON(schema, starterContent.content);
			let currentKey = earliestKey;

			Object.keys(discussions).forEach((discussionId) => {
				if (discussions[discussionId].currentKey === currentKey) {
					newDiscussions[discussionId] = {
						...discussions[discussionId],
						selection: Selection.fromJSON(
							currentDoc,
							uncompressSelectionJSON(discussions[discussionId].selection),
						),
					};
				}
			});

			Object.keys(allChanges).forEach((changeKey) => {
				currentKey = changeKey;
				const changeVal = allChanges[changeKey];
				const uncompressedChangeArray = Array.isArray(changeVal) ? changeVal : [changeVal];

				/* Extract steps at current changeKey */
				const currentSteps = [];
				uncompressedChangeArray.forEach((stepContent) => {
					const compressedStepsJSON = stepContent.s;
					const uncompressedSteps = compressedStepsJSON.map((compressedStepJSON) => {
						return Step.fromJSON(schema, uncompressStepJSON(compressedStepJSON));
					});
					currentSteps.push(...uncompressedSteps);
				});

				/* Update currentDoc with steps at current changeKey */
				const nextDoc = currentSteps.reduce((prev, curr) => {
					const stepResult = curr.apply(prev);
					if (stepResult.failed) {
						console.error('Failed with ', stepResult.failed);
					}
					return stepResult.doc;
				}, currentDoc);

				currentDoc = nextDoc;

				/* Map all discussions in newDiscussions */
				const currentStepMaps = currentSteps.map((step) => {
					return step.getMap();
				});
				const currentMapping = new Mapping(currentStepMaps);

				Object.keys(newDiscussions).forEach((discussionId) => {
					const prevSelection = newDiscussions[discussionId].selection;
					newDiscussions[discussionId].selection = prevSelection.map(
						currentDoc,
						currentMapping,
					);
				});

				/* Init discussions that were made at this currentDoc */
				Object.keys(discussions).forEach((discussionId) => {
					if (discussions[discussionId].currentKey === currentKey) {
						newDiscussions[discussionId] = {
							...discussions[discussionId],
							selection: Selection.fromJSON(
								currentDoc,
								uncompressSelectionJSON(discussions[discussionId].selection),
							),
						};
					}
				});
			});
			const restoredDiscussions = {};
			Object.keys(newDiscussions).forEach((discussionId) => {
				const newDiscussion = newDiscussions[discussionId];
				restoredDiscussions[discussionId] = {
					...newDiscussion,
					currentKey: Number(currentKey),
					selection: compressSelectionJSON(newDiscussion.selection.toJSON()),
				};
			});
			return firebaseRef.child('discussions').set(restoredDiscussions);
		});
};
