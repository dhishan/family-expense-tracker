import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import { ClipboardDocumentIcon, ArrowPathIcon, UserPlusIcon } from '@heroicons/react/24/outline'
import { familyApi } from '../services/api'
import { useAuthStore } from '../store/auth'

export default function Settings() {
  const { user, family, familyMembers, setFamily, setFamilyMembers, setUser } = useAuthStore()
  const queryClient = useQueryClient()
  const [_showJoinModal, setShowJoinModal] = useState(false)

  // Create family form
  const {
    register: registerCreate,
    handleSubmit: handleCreateSubmit,
    formState: { errors: createErrors },
  } = useForm<{ name: string }>()

  // Join family form
  const {
    register: registerJoin,
    handleSubmit: handleJoinSubmit,
    formState: { errors: joinErrors },
  } = useForm<{ invite_code: string }>()

  // Create family mutation
  const createFamilyMutation = useMutation({
    mutationFn: familyApi.create,
    onSuccess: async (newFamily) => {
      setFamily(newFamily)
      // Update user with new family_id
      setUser({ ...user!, family_id: newFamily.id })
      // Fetch members
      const members = await familyApi.getMembers(newFamily.id)
      setFamilyMembers(members)
      queryClient.invalidateQueries()
      toast.success('Family created!')
    },
    onError: () => toast.error('Failed to create family'),
  })

  // Join family mutation
  const joinFamilyMutation = useMutation({
    mutationFn: familyApi.joinByCode,
    onSuccess: async (joinedFamily) => {
      setFamily(joinedFamily)
      setUser({ ...user!, family_id: joinedFamily.id })
      const members = await familyApi.getMembers(joinedFamily.id)
      setFamilyMembers(members)
      queryClient.invalidateQueries()
      setShowJoinModal(false)
      toast.success('Joined family!')
    },
    onError: () => toast.error('Invalid invite code'),
  })

  // Regenerate invite code mutation
  const regenerateCodeMutation = useMutation({
    mutationFn: () => familyApi.regenerateInviteCode(family!.id),
    onSuccess: (data) => {
      setFamily({ ...family!, invite_code: data.invite_code })
      toast.success('Invite code regenerated!')
    },
    onError: () => toast.error('Failed to regenerate code'),
  })

  // Leave family mutation
  const leaveFamilyMutation = useMutation({
    mutationFn: () => familyApi.leave(family!.id),
    onSuccess: () => {
      setFamily(null)
      setFamilyMembers([])
      setUser({ ...user!, family_id: null })
      queryClient.invalidateQueries()
      toast.success('Left family')
    },
    onError: () => toast.error('Failed to leave family'),
  })

  const copyInviteCode = () => {
    if (family?.invite_code) {
      navigator.clipboard.writeText(family.invite_code)
      toast.success('Invite code copied!')
    }
  }

  const onCreateFamily = (data: { name: string }) => {
    createFamilyMutation.mutate(data.name)
  }

  const onJoinFamily = (data: { invite_code: string }) => {
    joinFamilyMutation.mutate(data.invite_code)
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* User Profile */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Profile</h2>
        <div className="flex items-center gap-4">
          {user?.photo_url ? (
            <img
              src={user.photo_url}
              alt={user.display_name}
              className="h-16 w-16 rounded-full"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-primary-100 flex items-center justify-center">
              <span className="text-2xl font-medium text-primary-700">
                {user?.display_name?.[0]?.toUpperCase()}
              </span>
            </div>
          )}
          <div>
            <p className="font-semibold text-gray-900">{user?.display_name}</p>
            <p className="text-gray-500">{user?.email}</p>
          </div>
        </div>
      </div>

      {/* Family Section */}
      {family ? (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Family</h2>
          
          <div className="space-y-6">
            {/* Family name */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">
                Family Name
              </label>
              <p className="text-lg font-semibold text-gray-900">{family.name}</p>
            </div>

            {/* Invite code */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-1">
                Invite Code
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-4 py-2 bg-gray-100 rounded-lg font-mono text-lg">
                  {family.invite_code}
                </code>
                <button
                  onClick={copyInviteCode}
                  className="p-2 text-gray-500 hover:text-primary-600"
                  title="Copy code"
                >
                  <ClipboardDocumentIcon className="h-6 w-6" />
                </button>
                <button
                  onClick={() => regenerateCodeMutation.mutate()}
                  disabled={regenerateCodeMutation.isPending}
                  className="p-2 text-gray-500 hover:text-primary-600"
                  title="Generate new code"
                >
                  <ArrowPathIcon className={`h-6 w-6 ${regenerateCodeMutation.isPending ? 'animate-spin' : ''}`} />
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Share this code with family members to let them join
              </p>
            </div>

            {/* Members */}
            <div>
              <label className="block text-sm font-medium text-gray-500 mb-2">
                Members ({familyMembers.length})
              </label>
              <div className="space-y-2">
                {familyMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg"
                  >
                    {member.photo_url ? (
                      <img
                        src={member.photo_url}
                        alt={member.display_name}
                        className="h-10 w-10 rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-primary-100 flex items-center justify-center">
                        <span className="font-medium text-primary-700">
                          {member.display_name[0]?.toUpperCase()}
                        </span>
                      </div>
                    )}
                    <div>
                      <p className="font-medium text-gray-900">{member.display_name}</p>
                      <p className="text-sm text-gray-500">{member.email}</p>
                    </div>
                    {member.id === user?.id && (
                      <span className="ml-auto text-xs bg-primary-100 text-primary-700 px-2 py-1 rounded">
                        You
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Leave family */}
            <div className="pt-4 border-t">
              <button
                onClick={() => {
                  if (confirm('Are you sure you want to leave this family?')) {
                    leaveFamilyMutation.mutate()
                  }
                }}
                disabled={leaveFamilyMutation.isPending}
                className="text-red-600 hover:text-red-700 text-sm font-medium"
              >
                Leave Family
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Create family */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Create a Family</h2>
            <form onSubmit={handleCreateSubmit(onCreateFamily)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Family Name
                </label>
                <input
                  type="text"
                  {...registerCreate('name', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="e.g., The Smiths"
                />
                {createErrors.name && (
                  <p className="text-red-500 text-sm mt-1">Name is required</p>
                )}
              </div>
              <button
                type="submit"
                disabled={createFamilyMutation.isPending}
                className="w-full px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
              >
                {createFamilyMutation.isPending ? 'Creating...' : 'Create Family'}
              </button>
            </form>
          </div>

          {/* Or join */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-gray-50 text-gray-500">or</span>
            </div>
          </div>

          {/* Join family */}
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Join a Family</h2>
            <form onSubmit={handleJoinSubmit(onJoinFamily)} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Invite Code
                </label>
                <input
                  type="text"
                  {...registerJoin('invite_code', { required: true })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  placeholder="Enter invite code"
                />
                {joinErrors.invite_code && (
                  <p className="text-red-500 text-sm mt-1">Invite code is required</p>
                )}
              </div>
              <button
                type="submit"
                disabled={joinFamilyMutation.isPending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-primary-600 text-primary-600 rounded-lg hover:bg-primary-50 disabled:opacity-50"
              >
                <UserPlusIcon className="h-5 w-5" />
                {joinFamilyMutation.isPending ? 'Joining...' : 'Join Family'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* App info */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">About</h2>
        <div className="text-sm text-gray-600 space-y-2">
          <p>Family Expense Tracker v1.0.0</p>
          <p>Track, budget, and manage your family's expenses together.</p>
        </div>
      </div>
    </div>
  )
}
