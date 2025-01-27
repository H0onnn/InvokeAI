import { isAnyOf } from '@reduxjs/toolkit';
import { logger } from 'app/logging/logger';
import type { AppStartListening } from 'app/store/middleware/listenerMiddleware';
import type { AppDispatch } from 'app/store/store';
import { parseify } from 'common/util/serialize';
import {
  caLayerImageChanged,
  caLayerModelChanged,
  caLayerProcessedImageChanged,
  caLayerProcessorConfigChanged,
  caLayerProcessorPendingBatchIdChanged,
  caLayerRecalled,
  isControlAdapterLayer,
} from 'features/controlLayers/store/controlLayersSlice';
import { CA_PROCESSOR_DATA } from 'features/controlLayers/util/controlAdapters';
import { isImageOutput } from 'features/nodes/types/common';
import { addToast } from 'features/system/store/systemSlice';
import { t } from 'i18next';
import { getImageDTO } from 'services/api/endpoints/images';
import { queueApi } from 'services/api/endpoints/queue';
import type { BatchConfig } from 'services/api/types';
import { socketInvocationComplete } from 'services/events/actions';
import { assert } from 'tsafe';

const matcher = isAnyOf(caLayerImageChanged, caLayerProcessorConfigChanged, caLayerModelChanged, caLayerRecalled);

const DEBOUNCE_MS = 300;
const log = logger('session');

/**
 * Simple helper to cancel a batch and reset the pending batch ID
 */
const cancelProcessorBatch = async (dispatch: AppDispatch, layerId: string, batchId: string) => {
  const req = dispatch(queueApi.endpoints.cancelByBatchIds.initiate({ batch_ids: [batchId] }));
  log.trace({ batchId }, 'Cancelling existing preprocessor batch');
  try {
    await req.unwrap();
  } catch {
    // no-op
  } finally {
    req.reset();
    // Always reset the pending batch ID - the cancel req could fail if the batch doesn't exist
    dispatch(caLayerProcessorPendingBatchIdChanged({ layerId, batchId: null }));
  }
};

export const addControlAdapterPreprocessor = (startAppListening: AppStartListening) => {
  startAppListening({
    matcher,
    effect: async (action, { dispatch, getState, cancelActiveListeners, delay, take, signal }) => {
      const layerId = caLayerRecalled.match(action) ? action.payload.id : action.payload.layerId;

      // Cancel any in-progress instances of this listener
      cancelActiveListeners();
      log.trace('Control Layer CA auto-process triggered');

      // Delay before starting actual work
      await delay(DEBOUNCE_MS);

      // Double-check that we are still eligible for processing
      const state = getState();
      const layer = state.controlLayers.present.layers.filter(isControlAdapterLayer).find((l) => l.id === layerId);

      // If we have no image or there is no processor config, bail
      if (!layer) {
        return;
      }

      const image = layer.controlAdapter.image;
      const config = layer.controlAdapter.processorConfig;

      if (!image || !config) {
        // The user has reset the image or config, so we should clear the processed image
        dispatch(caLayerProcessedImageChanged({ layerId, imageDTO: null }));
      }

      // At this point, the user has stopped fiddling with the processor settings and there is a processor selected.

      // If there is a pending processor batch, cancel it.
      if (layer.controlAdapter.processorPendingBatchId) {
        cancelProcessorBatch(dispatch, layerId, layer.controlAdapter.processorPendingBatchId);
      }

      // @ts-expect-error: TS isn't able to narrow the typing of buildNode and `config` will error...
      const processorNode = CA_PROCESSOR_DATA[config.type].buildNode(image, config);
      const enqueueBatchArg: BatchConfig = {
        prepend: true,
        batch: {
          graph: {
            nodes: {
              [processorNode.id]: {
                ...processorNode,
                // Control images are always intermediate - do not save to gallery
                is_intermediate: true,
              },
            },
            edges: [],
          },
          runs: 1,
        },
      };

      // Kick off the processor batch
      const req = dispatch(
        queueApi.endpoints.enqueueBatch.initiate(enqueueBatchArg, {
          fixedCacheKey: 'enqueueBatch',
        })
      );

      try {
        const enqueueResult = await req.unwrap();
        // TODO(psyche): Update the pydantic models, pretty sure we will _always_ have a batch_id here, but the model says it's optional
        assert(enqueueResult.batch.batch_id, 'Batch ID not returned from queue');
        dispatch(caLayerProcessorPendingBatchIdChanged({ layerId, batchId: enqueueResult.batch.batch_id }));
        log.debug({ enqueueResult: parseify(enqueueResult) }, t('queue.graphQueued'));

        // Wait for the processor node to complete
        const [invocationCompleteAction] = await take(
          (action): action is ReturnType<typeof socketInvocationComplete> =>
            socketInvocationComplete.match(action) &&
            action.payload.data.queue_batch_id === enqueueResult.batch.batch_id &&
            action.payload.data.source_node_id === processorNode.id
        );

        // We still have to check the output type
        assert(
          isImageOutput(invocationCompleteAction.payload.data.result),
          `Processor did not return an image output, got: ${invocationCompleteAction.payload.data.result}`
        );
        const { image_name } = invocationCompleteAction.payload.data.result.image;

        const imageDTO = await getImageDTO(image_name);
        assert(imageDTO, "Failed to fetch processor output's image DTO");

        // Whew! We made it. Update the layer with the processed image
        log.debug({ layerId, imageDTO }, 'ControlNet image processed');
        dispatch(caLayerProcessedImageChanged({ layerId, imageDTO }));
        dispatch(caLayerProcessorPendingBatchIdChanged({ layerId, batchId: null }));
      } catch (error) {
        if (signal.aborted) {
          // The listener was canceled - we need to cancel the pending processor batch, if there is one (could have changed by now).
          const pendingBatchId = getState()
            .controlLayers.present.layers.filter(isControlAdapterLayer)
            .find((l) => l.id === layerId)?.controlAdapter.processorPendingBatchId;
          if (pendingBatchId) {
            cancelProcessorBatch(dispatch, layerId, pendingBatchId);
          }
          log.trace('Control Adapter preprocessor cancelled');
        } else {
          // Some other error condition...
          log.error({ enqueueBatchArg: parseify(enqueueBatchArg) }, t('queue.graphFailedToQueue'));

          if (error instanceof Object) {
            if ('data' in error && 'status' in error) {
              if (error.status === 403) {
                dispatch(caLayerImageChanged({ layerId, imageDTO: null }));
                return;
              }
            }
          }

          dispatch(
            addToast({
              title: t('queue.graphFailedToQueue'),
              status: 'error',
            })
          );
        }
      } finally {
        req.reset();
      }
    },
  });
};
