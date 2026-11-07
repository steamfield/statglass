import { type CommandResult, unwrap } from "@core/transport";
import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";

export interface CommandMutationOptions<TData, TVars> {
  /** The command's name in the failure log, such as `reset_history`. */
  name: string;
  /** The toast for a failure: a typed `CommandFailure` or a rejected call. */
  errorText: (error: Error) => string;
  /** Queries a success makes stale; refetched without being awaited. */
  invalidate?: (variables: TVars) => readonly QueryKey[];
  onSuccess?: (data: TData, variables: TVars) => void;
}

/**
 * A one-shot command: run it, then on success invalidate and call
 * `onSuccess`; on a typed error or a rejected call, log and toast. `isPending`
 * settles on every path, so a busy control never sticks.
 */
export function useCommandMutation<TData, TVars = void>(
  fn: (variables: TVars) => Promise<CommandResult<TData>>,
  {
    name,
    errorText,
    invalidate,
    onSuccess,
  }: CommandMutationOptions<TData, TVars>
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: TVars) => unwrap(fn(variables)),
    onSuccess: (data, variables) => {
      for (const queryKey of invalidate?.(variables) ?? []) {
        void queryClient.invalidateQueries({ queryKey });
      }
      onSuccess?.(data, variables);
    },
    onError: (error, variables) => {
      console.error(`[command] ${name} failed`, { variables, error });
      toast.error(errorText(error));
    },
  });
}
