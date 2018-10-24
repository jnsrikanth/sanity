// @flow
import {Change, Operation} from 'slate'
import {flatten, isEqual} from 'lodash'
import {editorValueToBlocks, normalizeBlock} from '@sanity/block-tools'

import type {
  Block,
  BlockContentFeatures,
  FormBuilderValue,
  SlateChange,
  SlateOperation,
  SlateValue,
  Type
} from '../typeDefs'

import {applyAll} from '../../../simplePatch'
import {unset, set, insert, setIfMissing} from '../../../PatchEvent'
import buildEditorSchema from './buildEditorSchema'
import createEditorController from './createEditorController'

export const VALUE_TO_JSON_OPTS = {
  preserveData: true,
  preserveKeys: true,
  preserveSelection: false,
  preserveHistory: false
}

function setKey(key: string, value: FormBuilderValue | Block) {
  value._key = key
  if (
    value._type === 'block' &&
    typeof value.children === 'object' &&
    Array.isArray(value.children)
  ) {
    value.children.forEach((child, index) => {
      child._key = `${value._key}${index}`
    })
  }
  return value
}

export default function createChangeToPatches(
  blockContentFeatures: BlockContentFeatures,
  blockContentType: Type
) {
  const schema = buildEditorSchema(blockContentFeatures)
  const controller = createEditorController({
    value: null,
    plugins: [{schema}]
  })

  function setNodePatchSimple(
    change: SlateChange,
    operation: Operation,
    value: FormBuilderValue[]
  ) {
    const appliedBlocks = editorValueToBlocks(
      {
        document: {
          nodes: [
            change
              .applyOperations([operation])
              .value.document.nodes.get(operation.path.get(0))
              .toJSON(VALUE_TO_JSON_OPTS)
          ]
        }
      },
      blockContentType
    )

    // Value is undefined
    if (!value && appliedBlocks) {
      return setIfMissing(appliedBlocks.map(normalizeBlock))
    }
    // Value is empty
    if (value && value.length === 0) {
      return set(appliedBlocks.map(normalizeBlock), [])
    }
    const changedBlock = appliedBlocks[0]
    setKey(changedBlock._key, normalizeBlock(changedBlock))
    return set(normalizeBlock(changedBlock), [{_key: changedBlock._key}])
  }

  function setNodePatch(change: SlateChange, operation: SlateOperation, value: FormBuilderValue[]) {
    const appliedBlocks = editorValueToBlocks(
      change.applyOperations([operation]).value.toJSON(VALUE_TO_JSON_OPTS),
      blockContentType
    )
    // Value is undefined
    if (!value && appliedBlocks) {
      return setIfMissing(appliedBlocks.map(normalizeBlock))
    }
    // Value is empty
    if (value && value.length === 0) {
      return set(appliedBlocks.map(normalizeBlock), [])
    }
    const changedBlock = appliedBlocks[operation.path.get(0)]

    // Don't do anything if nothing is changed
    if (isEqual(normalizeBlock(changedBlock), normalizeBlock(value[operation.path.get(0)]))) {
      return []
    }

    setKey(value[operation.path.get(0)]._key, changedBlock)
    return set(normalizeBlock(changedBlock), [{_key: changedBlock._key}])
  }

  function insertNodePatch(change: Change, operation: Operation, value: FormBuilderValue[]) {
    const patches = []
    const appliedBlocks = editorValueToBlocks(
      change.applyOperations([operation]).value.toJSON(VALUE_TO_JSON_OPTS),
      blockContentType
    )

    if (operation.path.size === 1) {
      if (!value.length) {
        return set(
          appliedBlocks.map(normalizeBlock).map((block, index) => {
            return setKey(change.value.document.nodes.get(index).key, block)
          })
        )
      }
      let position = 'after'
      let afterKey
      if (operation.path.get(0) === 0) {
        afterKey = value[0]._key
        position = 'before'
      } else {
        afterKey = value[operation.path.get(0) - 1]._key
      }
      const newBlock = appliedBlocks[operation.path.get(0)]
      const newKey = change.value.document.nodes.get(operation.path.get(0)).key
      setKey(newKey, newBlock)
      const oldData = change.value.document.nodes.get(operation.path.get(0)).data.toObject()
      if (oldData.value) {
        oldData.value._key = newKey
      }
      change.setNodeByKey(newKey, {data: {...oldData, _key: newKey}})
      patches.push(insert([normalizeBlock(newBlock)], position, [{_key: afterKey}]))
    }

    if (operation.path.size > 1) {
      const block = appliedBlocks[operation.path.get(0)]
      setKey(block._key, block)
      if (block._type === 'block') {
        patches.push(set(normalizeBlock(block), [{_key: block._key}]))
      }
    }
    return patches
  }

  function splitNodePatch(change: SlateChange, operation: Operation) {
    const patches = []
    const appliedBlocks = editorValueToBlocks(
      change.applyOperations([operation]).value.toJSON(VALUE_TO_JSON_OPTS),
      blockContentType
    )
    const splitBlock = appliedBlocks[operation.path.get(0)]
    setKey(splitBlock._key, splitBlock)
    if (operation.path.size === 1) {
      patches.push(set(splitBlock, [{_key: splitBlock._key}]))
      const newBlock = appliedBlocks[operation.path.get(0) + 1]
      const newKey = change.value.document.nodes.get(operation.path.get(0) + 1).key
      setKey(newKey, newBlock)
      // Update the change value data with new key
      const oldData = change.value.document.nodes.get(operation.path.get(0) + 1).data.toObject()
      if (oldData.value && oldData.value._key) {
        oldData.value._key = newKey
      }
      change.setNodeByKey(newKey, {data: {...oldData, _key: newKey}})
      patches.push(insert([normalizeBlock(newBlock)], 'after', [{_key: splitBlock._key}]))
    }
    if (operation.path.size > 1) {
      patches.push(set(normalizeBlock(splitBlock), [{_key: splitBlock._key}]))
    }
    return patches
  }

  function mergeNodePatch(change: SlateChange, operation: Operation, value: FormBuilderValue[]) {
    const patches = []
    const appliedBlocks = editorValueToBlocks(
      change.applyOperations([operation]).value.toJSON(VALUE_TO_JSON_OPTS),
      blockContentType
    )
    if (operation.path.size === 1) {
      const mergedBlock = value[operation.path.get(0)]
      const targetBlock = appliedBlocks[operation.path.get(0) - 1]
      patches.push(
        unset([
          {
            _key: mergedBlock._key
          }
        ])
      )
      patches.push(
        set(normalizeBlock(targetBlock), [{_key: value[operation.path.get(0) - 1]._key}])
      )
    }
    if (operation.path.size > 1) {
      const targetBlock = appliedBlocks[operation.path.get(0)]
      setKey(value[operation.path.get(0)]._key, targetBlock)
      patches.push(set(normalizeBlock(targetBlock), [{_key: targetBlock._key}]))
    }
    return patches
  }

  function moveNodePatch(change: SlateChange, operation: Operation, value: FormBuilderValue[]) {
    change.applyOperations([operation])
    const patches = []
    if (operation.path.size === 1) {
      if (operation.path.get(0) === operation.newPath.get(0)) {
        return []
      }
      const block = value[operation.path.get(0)]
      patches.push(
        unset([
          {
            _key: block._key
          }
        ])
      )
      let position = 'after'
      let posKey
      if (operation.newPath.get(0) === 0) {
        posKey = value[0]._key
        position = 'before'
      } else {
        posKey = value[operation.newPath.get(0) - 1]._key
      }
      setKey(block._key, block)
      patches.push(insert([normalizeBlock(block)], position, [{_key: posKey}]))
    } else {
      const appliedBlocks = editorValueToBlocks(
        change.value.toJSON(VALUE_TO_JSON_OPTS),
        blockContentType
      )
      const changedBlockFrom = appliedBlocks[operation.path.get(0)]
      const changedBlockTo = appliedBlocks[operation.newPath.get(0)]
      setKey(changedBlockFrom._key, changedBlockFrom)
      setKey(changedBlockTo._key, changedBlockTo)
      patches.push(set(normalizeBlock(changedBlockFrom), [{_key: changedBlockFrom._key}]))
      patches.push(set(normalizeBlock(changedBlockTo), [{_key: changedBlockTo._key}]))
    }
    return patches
  }

  function removeNodePatch(change: SlateChange, operation: Operation, value: FormBuilderValue[]) {
    change.applyOperations([operation])
    const patches = []
    const block = value[operation.path.get(0)]
    if (operation.path.size === 1) {
      // Unset block
      patches.push(unset([{_key: block._key}]))
    }
    if (operation.path.size > 1) {
      // Only relevant for 'block' type blocks
      if (block._type !== 'block') {
        return patches
      }
      const appliedBlocks = editorValueToBlocks(
        change.value.toJSON(VALUE_TO_JSON_OPTS),
        blockContentType
      )
      const changedBlock = appliedBlocks[operation.path.get(0)]
      setKey(block._key, changedBlock)
      patches.push(set(normalizeBlock(changedBlock), [{_key: changedBlock._key}]))
    }
    if (patches.length === 0) {
      throw new Error(
        `Don't know how to unset ${JSON.stringify(operation.toJSON(VALUE_TO_JSON_OPTS))}`
      )
    }
    return patches
  }

  function noOpPatch(change: SlateChange, operation: Operation) {
    change.applyOperations([operation])
    return []
  }

  function applyPatchesOnValue(patches, value) {
    let _patches = patches
    if (!patches || (Array.isArray(patches) && !patches.length)) {
      return value
    }
    if (!Array.isArray(patches)) {
      _patches = [patches]
    }
    return applyAll(value, _patches)
  }

  return function changeToPatches(
    unchangedEditorValue: SlateValue,
    change: SlateChange,
    value: ?(FormBuilderValue[])
  ) {
    const {operations} = change
    let _value = value ? [...value] : []
    controller.setValue(unchangedEditorValue)
    const patches = []
    controller.change(unchanged => {
      // eslint-disable-next-line complexity
      operations.forEach((operation: Operation, index: number) => {
        const _patches = []
        // console.log('OPERATION:', JSON.stringify(operation, null, 2))
        switch (operation.type) {
          case 'insert_text':
            _patches.push(setNodePatchSimple(unchanged, operation, _value))
            break
          case 'remove_text':
            _patches.push(setNodePatchSimple(unchanged, operation, _value))
            break
          case 'add_mark':
            _patches.push(setNodePatchSimple(unchanged, operation, _value))
            break
          case 'remove_mark':
            _patches.push(setNodePatchSimple(unchanged, operation, _value))
            break
          case 'set_node':
            _patches.push(setNodePatch(unchanged, operation, _value))
            break
          case 'insert_node':
            _patches.push(insertNodePatch(unchanged, operation, _value))
            break
          case 'remove_node':
            _patches.push(removeNodePatch(unchanged, operation, _value))
            break
          case 'split_node':
            _patches.push(splitNodePatch(unchanged, operation))
            break
          case 'merge_node':
            _patches.push(mergeNodePatch(unchanged, operation, _value))
            break
          case 'move_node':
            _patches.push(moveNodePatch(unchanged, operation, _value))
            break
          default:
            _patches.push(noOpPatch(unchanged, operation))
        }
        // console.log('BLOCKS BEFORE:', JSON.stringify(_value, null, 2))
        // console.log(
        //   'CHANGE DOCUMENT VALUE:',
        //   JSON.stringify(unchanged.value.document.toJSON(VALUE_TO_JSON_OPTS), null, 2)
        // )
        const lastPatchSet = flatten(_patches)
        if (lastPatchSet) {
          _value = applyPatchesOnValue(lastPatchSet, _value)
        }
        // console.log('PATCH-SET:', JSON.stringify(lastPatchSet, null, 2))
        // console.log('BLOCKS AFTER:', JSON.stringify(_value, null, 2))
        patches.push(lastPatchSet)
      })
    })

    let result = flatten(patches)
    // Optimize patches (remove sequential set patches that targets the same block)
    result = result.filter((patch, index) => {
      if (!patch) {
        return false
      }
      const nextPatch = result[index + 1]
      if (
        nextPatch &&
        nextPatch.type === 'set' &&
        patch.type === 'set' &&
        isEqual(patch.path, nextPatch.path)
      ) {
        return false
      }
      return true
    })
    // console.log('PATCHES:', JSON.stringify(result, null, 2))
    return result
  }
}
